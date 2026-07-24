/* No Chrome só existe o global `chrome` (callback-based, mas com suporte a
   Promise quando o callback é omitido nas APIs que usamos aqui). No Firefox
   `browser` já existe nativamente. Este shim deixa o resto do código
   (background, content scripts, popup, options) usar sempre `browser.*`
   sem precisar de branches por navegador. Precisa ser o primeiro script
   carregado em cada contexto. */
if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
  globalThis.browser = chrome;
}
