// Wireless device link in the UI: the active transport comes only from the backend's record of it (snapshot.transport); a Wi-Fi socket is not a
// working device link until the per-device-key handshake completed; a closed link is Disconnected, never "connected once".
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DevicePage } from '../device/device.jsx';
import { transportOf } from '../telemetry/devicePresentation.js';

const base = { connection: 'CONNECTED', handshake: true, origin: 'physical_device', telemetry_fresh: true, firmware: '1.1.1', device_profile: 'ota_led_bench',
  control_blockers: ['OTA LED BENCH DEVICE: this board runs the LED-only OTA bench firmware, which has no motor control'], counters: {}, sensor_status: {}, values: {},
  last_rx_unix: Date.now() / 1000 - 0.5 };
const wifi = { ...base, transport: { kind: 'wifi', remote: '10.177.25.41', port: 'wifi:10.177.25.41', since: 1 }, session: { state: 'active', active: true },
  wifi_link: { enabled: true, active: true, remote: '10.177.25.41', since: 1793814828, attempts: 3, usb_autoconnect_paused: false,
    events: [{ at: 1793814828, kind: 'connected', remote: '10.177.25.41' }] } };
const usb = { ...base, transport: { kind: 'usb', port: 'COM10' }, port: 'COM10', session: { state: 'active', active: true }, wifi_link: { enabled: false, active: false, attempts: 0, events: [] } };
const stream = (snap) => ({ snap, events: [], ws: 'open', error: null, refresh: () => {} });

describe('wireless device link', () => {
  it('names the transport only from the backend record, and only while a link exists', () => {
    expect(transportOf(wifi)).toBe('Wi-Fi');
    expect(transportOf(usb)).toBe('USB');
    expect(transportOf({ ...wifi, session: { active: false } })).toBe('Wi-Fi (authenticating)');       // an open socket is not an authenticated device
    expect(transportOf({ ...wifi, connection: 'DISCONNECTED' })).toBeNull();                            // a past link is not a current one
    expect(transportOf({ ...wifi, transport: null })).toBeNull();
    expect(transportOf(undefined)).toBeNull();
  });

  it('Device & Safety shows Connected — Wi-Fi, the authentication state and the link details', async () => {
    await act(async () => {
      render(<DevicePage stream={stream(wifi)} role="viewer" embedded />);
    });
    expect(screen.getByTestId('conn-head')).toHaveTextContent('Connected — Wi-Fi');
    expect(screen.getByTestId('conn-method')).toHaveTextContent('Wi-Fi');
    expect(screen.getByTestId('conn-auth')).toHaveTextContent('yes');
    expect(screen.getByTestId('dev-conn')).toHaveTextContent('Wi-Fi link from 10.177.25.41');
    expect(screen.getByTestId('wifi-link-details')).toHaveTextContent('Connection attempts');
  });

  it('a USB link says USB', async () => {
    await act(async () => {
      render(<DevicePage stream={stream(usb)} role="viewer" embedded />);
    });
    expect(screen.getByTestId('conn-head')).toHaveTextContent('Connected — USB');
    expect(screen.getByTestId('dev-conn')).toHaveTextContent('Port COM10');
  });

  it('a link that is not yet authenticated never says the device is authenticated', async () => {
    await act(async () => {
      render(<DevicePage stream={stream({ ...wifi, session: { state: 'wait_challenge', active: false } })} role="viewer" embedded />);
    });
    expect(screen.getByTestId('conn-head')).toHaveTextContent('Wi-Fi (authenticating)');
    expect(screen.getByTestId('conn-auth')).toHaveTextContent('no');
  });

  it('after the link closed the device is Disconnected and no transport is claimed', async () => {
    await act(async () => {
      render(<DevicePage stream={stream({ ...wifi, connection: 'DISCONNECTED', handshake: false, transport: null, session: { active: false },
        wifi_link: { ...wifi.wifi_link, active: false, events: [...wifi.wifi_link.events, { at: 1793814900, kind: 'disconnected', remote: '10.177.25.41', reason: 'closed by the device' }] } })} role="viewer" embedded />);
    });
    expect(screen.getByTestId('conn-head')).toHaveTextContent('Disconnected');
    expect(screen.getByTestId('conn-head')).not.toHaveTextContent('Wi-Fi');
    expect(screen.getByTestId('conn-method')).toHaveTextContent('none');
    expect(screen.getByTestId('wifi-link-details')).toHaveTextContent('closed by the device');
  });

  it('shows the real readiness state and reason, never plain "connected" for a link that cannot take commands', async () => {
    const flapping = { ...wifi, readiness: { state: 'COMMUNICATION_FAILURE', label: 'Communication failure', ready: false, reasons: ['the Wi-Fi link dropped 4 times in the last 120 s'] } };
    await act(async () => { render(<DevicePage stream={stream(flapping)} role="viewer" embedded />); });
    const r = screen.getByTestId('conn-readiness');
    expect(r).toHaveTextContent('Communication failure'); expect(r).toHaveTextContent('commands are not routed yet'); expect(r).toHaveTextContent('dropped 4 times');
  });

  it('on USB, shows whether the Wi-Fi standby link is ready before the cable is pulled, and the board-reported link measurements', async () => {
    const sb = { remote: '10.177.25.41', since: 1793814828, claimed_device_id: 'RIG-1', silent_s: 0.2, messages: 120, invalid_lines: 0, alive: true };
    const onUsb = { ...usb, wifi_link: { enabled: true, active: false, standby: sb, promotions: 0, attempts: 2, events: [] },
      readiness: { state: 'USB_CONNECTED', label: 'USB connected', ready: true, reasons: [], wifi_standby: { state: 'READY', ready: true, reason: 'Wi-Fi standby link is live' } },
      net_info: { rssi: -52, ip: '10.177.25.41', reset_reason: 'power-on', link_close_cause: '', links_since_boot: 1, max_send_ms: 14,
        link: { power_save: 'off', tcp_nodelay_sockets: 1, avg_send_ms: 4, frames_sent: 300, send_histogram: { '<20 ms': 298, '20-99 ms': 2, '100-299 ms': 0, '300-999 ms': 0, '>=1000 ms': 0 },
          telemetry_dropped: 0, priority_dropped: 0, rx_dropped: 0, wifi_disconnects: 0 } } };
    await act(async () => { render(<DevicePage stream={stream(onUsb)} role="viewer" embedded />); });
    expect(screen.getByTestId('wifi-standby')).toHaveTextContent('ready');
    expect(screen.getByTestId('wifi-standby-link')).toHaveTextContent('claims RIG-1');
    const d = screen.getByTestId('wifi-link-diag');
    expect(d).toHaveTextContent('-52 dBm'); expect(d).toHaveTextContent('avg 4 ms · max 14 ms'); expect(d).toHaveTextContent('<20 ms: 298'); expect(d).toHaveTextContent('off · TCP no-delay on');
  });
});
