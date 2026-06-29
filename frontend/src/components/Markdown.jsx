import { useMemo, useRef, useEffect } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js';
import { Copy, Check } from 'lucide-react';

marked.setOptions({
  breaks: true,
  gfm: true,
});

// Renderer personalizzato: ogni blocco di codice è evidenziato e racchiuso in un
// contenitore con header (linguaggio) per il pulsante "copia".
const renderer = new marked.Renderer();
renderer.code = (codeOrObj, lang) => {
  // marked v4 passa (string, lang), marked v5 passa un oggetto {text, lang, escaped}
  const code = typeof codeOrObj === 'object' ? (codeOrObj.text || '') : (codeOrObj || '');
  const rawLang = typeof codeOrObj === 'object' ? codeOrObj.lang : lang;
  const language = rawLang && hljs.getLanguage(rawLang) ? rawLang : 'plaintext';
  const highlighted = hljs.highlight(String(code), { language }).value;
  const encoded = encodeURIComponent(String(code));
  return `<div class="code-block" data-code="${encoded}">
    <div class="code-head"><span class="code-lang">${language}</span></div>
    <pre><code class="hljs language-${language}">${highlighted}</code></pre>
  </div>`;
};

export default function Markdown({ content }) {
  const ref = useRef(null);
  const html = useMemo(() => {
    try {
      return marked.parse(content || '', { renderer });
    } catch {
      // Se il parsing fallisce, mostra il testo grezzo senza crash
      return `<pre style="white-space:pre-wrap">${String(content || '').replace(/</g, '&lt;')}</pre>`;
    }
  }, [content]);

  // Aggiunge i pulsanti di copia ai blocchi di codice dopo il render.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll('.code-block').forEach((block) => {
      if (block.querySelector('.code-copy')) return;
      const btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.innerHTML = 'Copia';
      btn.onclick = () => {
        navigator.clipboard.writeText(decodeURIComponent(block.dataset.code || ''));
        btn.innerHTML = 'Copiato';
        setTimeout(() => (btn.innerHTML = 'Copia'), 1500);
      };
      block.querySelector('.code-head')?.appendChild(btn);
    });
  }, [html]);

  return <div className="markdown" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Icone esportate per riuso eventuale.
export { Copy, Check };
