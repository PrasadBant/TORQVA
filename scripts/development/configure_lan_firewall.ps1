[CmdletBinding()]
param(
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$rules = @(
    @{ Name = 'TORQVA LAN Frontend'; Port = 5173; Program = 'C:\Program Files\nodejs\node.exe' },
    @{ Name = 'TORQVA LAN Backend API'; Port = 8000; Program = 'C:\Program Files\Python313\python.exe' },
    @{ Name = 'TORQVA LAN ESP32 TLS Gateway'; Port = 8443; Program = 'C:\Program Files\Python313\python.exe' }
)

foreach ($rule in $rules) {
    Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    if (-not $Remove) {
        New-NetFirewallRule `
            -DisplayName $rule.Name `
            -Description "TORQVA trusted-LAN TCP $($rule.Port); no internet-wide remote addresses" `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort $rule.Port `
            -Program $rule.Program `
            -RemoteAddress LocalSubnet `
            -Profile Private,Public | Out-Null
    }
}

if ($Remove) {
    Write-Host 'TORQVA LAN firewall rules removed.'
} else {
    Get-NetFirewallRule -DisplayName 'TORQVA LAN *' |
        Get-NetFirewallPortFilter |
        Select-Object InstanceID, Protocol, LocalPort |
        Format-Table -AutoSize
    Write-Host 'TORQVA LAN firewall rules installed for LocalSubnet only.'
}
