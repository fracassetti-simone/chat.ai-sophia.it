import { createRequire } from 'node:module';
import mammoth from 'mammoth';
import { marked } from 'marked';

// pdf-parse è CommonJS; lo importiamo con createRequire per evitare side-effect su import ESM.
const require = createRequire(import.meta.url);

// Estrae testo semplice da un buffer in base al tipo di file.
export async function extractText(buffer, mimeType, filename = '') {
  const name = filename.toLowerCase();

  if (mimeType === 'application/pdf' || name.endsWith('.pdf')) {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }

  if (
    mimeType?.startsWith('image/') ||
    /\.(jpg|jpeg|png|webp|gif)$/i.test(name)
  ) {
    // Le immagini non hanno testo estraibile: niente da salvare nel campo "extracted".
    return null;
  }

  if (name.endsWith('.md') || name.endsWith('.markdown')) {
    // Converte in HTML e poi rimuove i tag per ottenere testo leggibile.
    const html = marked.parse(buffer.toString('utf8'));
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // txt, json, yaml e simili: testo grezzo.
  return buffer.toString('utf8');
}
