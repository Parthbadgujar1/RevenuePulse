/**
 * Server-safe theme boot script (pure string; no React, no client directive).
 * Runs before first paint so there is no theme flash.
 */
export function themeBootScript() {
  return `(function(){try{var k='rp-theme',s=localStorage.getItem(k);if(s==='dark'||s==='light'){document.documentElement.classList.toggle('dark',s==='dark')}else if(matchMedia('(prefers-color-scheme: dark)').matches){document.documentElement.classList.add('dark')}}catch(e){}})();`;
}