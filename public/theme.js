(function(){
  const KEY = 'cc-theme';
  function apply(t){ document.documentElement.setAttribute('data-theme', t); }
  const saved = localStorage.getItem(KEY);
  const preferred = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  apply(saved || preferred);
  window.toggleTheme = function(){
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    apply(next);
  };
  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('[data-theme-toggle]').forEach(b => b.addEventListener('click', window.toggleTheme));
  });
})();
