// The browser keeps the token scoped to the current tab.

const KEY = 'torqva.token';

export function getToken() {
  try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; }
}
export function setToken(t) {
  try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage may be blocked */ }
}
