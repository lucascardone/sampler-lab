// UI check helper (dev only): __btn(/regex/, i) clicks the i-th button whose text or aria-label matches. Injected by mk.sh as "__PRE__".
window.__btn=(re,i=0)=>{const b=[...document.querySelectorAll('button')].filter(b=>re.test(b.textContent.trim())||re.test(b.getAttribute('aria-label')||''));if(!b[i])return 'NOTFOUND '+re;b[i].click();return 'ok';};
