import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

const WORKSPACE_DIR = path.join(os.homedir(), '.aura', 'workspace');
const PDF_TEMP_DIR = path.join(os.homedir(), '.aura', 'temp');

function ensureDirectories(): void {
  for (const dir of [WORKSPACE_DIR, PDF_TEMP_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function parsePageSpec(pageSpec: string, maxPages: number): number[] {
  const pages: number[] = [];
  
  if (pageSpec.toLowerCase() === 'all') {
    return Array.from({ length: maxPages }, (_, i) => i + 1);
  }
  
  const parts = pageSpec.split(',');
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= end && i <= maxPages; i++) {
        if (i > 0) pages.push(i);
      }
    } else {
      const num = parseInt(part.trim(), 10);
      if (num > 0 && num <= maxPages) pages.push(num);
    }
  }
  
  return [...new Set(pages)].sort((a, b) => a - b);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1]!, 16),
    g: parseInt(result[2]!, 16),
    b: parseInt(result[3]!, 16)
  } : { r: 0, g: 0, b: 0 };
}

function getPdfPageCount(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath);
    const str = content.toString('binary');
    const match = str.match(/\/Type\s*\/Page[^s]/g);
    return match ? match.length : 1;
  } catch {
    return 1;
  }
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getOutputPath(filename: string): string {
  ensureDirectories();
  return path.join(WORKSPACE_DIR, sanitizeFilename(filename));
}

function ensureInputFile(filePath: string): string {
  const inputPath = path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE_DIR, filePath);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }
  return inputPath;
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { shell: true });
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || stdout));
      }
    });
    
    proc.on('error', (err) => reject(err));
  });
}

async function runPdfLibScript(script: string): Promise<void> {
  const tempScript = path.join(PDF_TEMP_DIR, `pdf_${Date.now()}.mjs`);
  fs.writeFileSync(tempScript, script);
  try {
    await runCommand('node', [tempScript]);
    fs.unlinkSync(tempScript);
  } catch (err) {
    try { fs.unlinkSync(tempScript); } catch { /* ignore */ }
    throw err;
  }
}

export async function pdf_merge(args: {
  input_files: string[];
  output_file: string;
}, _ctx: unknown): Promise<unknown> {
  ensureDirectories();
  
  if (!args.input_files || args.input_files.length < 2) {
    throw new Error('At least 2 input files are required for merging');
  }
  
  const outputPath = getOutputPath(args.output_file || 'merged.pdf');
  const inputPaths = args.input_files.map(f => ensureInputFile(f));
  
  const script = `
import('pdf-lib').then(async ({ PDFDocument }) => {
  const fs = await import('fs');
  const pdfDoc = await PDFDocument.create();
  
  for (const inputPath of ${JSON.stringify(inputPaths)}) {
    const fileData = fs.readFileSync(inputPath);
    const srcDoc = await PDFDocument.load(fileData);
    const indices = srcDoc.getPageIndices();
    const copiedPages = await pdfDoc.copyPages(srcDoc, indices);
    copiedPages.forEach(page => pdfDoc.addPage(page));
  }
  
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync('${outputPath.replace(/\\/g, '\\\\')}', Buffer.from(pdfBytes));
  console.log('PDF merged successfully');
}).catch(err => { console.error(err); process.exit(1); });`;
  
  try {
    await runPdfLibScript(script);
    return { success: true, output_file: outputPath, message: `Merged ${args.input_files.length} PDF files` };
  } catch (err) {
    throw new Error(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pdf_split(args: {
  input_file: string;
  pages: string;
  output_prefix: string;
}, _ctx: unknown): Promise<unknown> {
  ensureDirectories();
  
  const inputPath = ensureInputFile(args.input_file);
  const pageCount = getPdfPageCount(inputPath);
  const pages = parsePageSpec(args.pages, pageCount);
  const prefix = args.output_prefix || path.basename(args.input_file, '.pdf');
  
  const script = `
import('pdf-lib').then(async ({ PDFDocument }) => {
  const fs = await import('fs');
  const inputData = fs.readFileSync('${inputPath.replace(/\\/g, '\\\\')}');
  const pdfDoc = await PDFDocument.load(inputData);
  const allPages = pdfDoc.getPages();
  
  const pageRanges = ${JSON.stringify(pages.map(p => `[${p-1}, ${p-1}]`))};
  
  for (let i = 0; i < pageRanges.length; i++) {
    const [start] = pageRanges[i];
    const newPdf = await PDFDocument.create();
    const copiedPages = await newPdf.copyPages(pdfDoc, [start]);
    copiedPages.forEach(page => newPdf.addPage(page));
    const pdfBytes = await newPdf.save();
    const outPath = \`\${'${path.join(WORKSPACE_DIR, prefix).replace(/\\\\/g, '\\\\\\\\')}'}_\${i+1}.pdf\`;
    fs.writeFileSync(outPath, Buffer.from(pdfBytes));
  }
  console.log('PDF split into ' + pageRanges.length + ' files');
}).catch(err => { console.error(err); process.exit(1); });`;
  
  try {
    await runPdfLibScript(script);
    return { success: true, files: pages.map(p => `${prefix}_page_${p}.pdf`), message: `Split into ${pages.length} files` };
  } catch (err) {
    throw new Error(`Split failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pdf_extract_pages(args: {
  input_file: string;
  page_numbers: string;
  output_file: string;
}, _ctx: unknown): Promise<unknown> {
  return pdf_split({
    input_file: args.input_file,
    pages: args.page_numbers,
    output_prefix: (args.output_file || 'extracted').replace('.pdf', ''),
  }, _ctx);
}

export async function pdf_add_signature(args: {
  input_file: string;
  output_file: string;
  signature_type: 'image' | 'typed';
  signature_value: string;
  page_number?: number;
  x_position?: number;
  y_position?: number;
  width?: number;
}, _ctx: unknown): Promise<unknown> {
  ensureDirectories();
  
  const inputPath = ensureInputFile(args.input_file);
  const outputPath = getOutputPath(args.output_file || 'signed.pdf');
  const pageNum = args.page_number || 1;
  const x = args.x_position || 100;
  const y = args.y_position || 100;
  const width = args.width || 150;
  
  let signatureImage = '';
  if (args.signature_type === 'image') {
    const sigPath = path.isAbsolute(args.signature_value) ? args.signature_value : path.join(WORKSPACE_DIR, args.signature_value);
    if (!fs.existsSync(sigPath)) throw new Error(`Signature image not found: ${sigPath}`);
    signatureImage = fs.readFileSync(sigPath).toString('base64');
  }
  
  const script = args.signature_type === 'image' ? `
import('pdf-lib').then(async ({ PDFDocument }) => {
  const fs = await import('fs');
  const inputData = fs.readFileSync('${inputPath.replace(/\\/g, '\\\\')}');
  const pdfDoc = await PDFDocument.load(inputData);
  const pages = pdfDoc.getPages();
  
  if (pages.length < ${pageNum}) throw new Error('Page does not exist');
  const page = pages[${pageNum - 1}];
  const { height } = page.getSize();
  
  const imageData = Buffer.from('${signatureImage}', 'base64');
  const image = await pdfDoc.embedPng(imageData);
  const dims = image.scale(${width} / image.width);
  page.drawImage('signature', {
    x: ${x}, y: height - ${y} - dims.height,
    width: dims.width, height: dims.height,
  });
  
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync('${outputPath.replace(/\\/g, '\\\\')}', Buffer.from(pdfBytes));
  console.log('Signature added');
}).catch(err => { console.error(err); process.exit(1); });` : `
import('pdf-lib').then(async ({ PDFDocument, StandardFonts }) => {
  const fs = await import('fs');
  const inputData = fs.readFileSync('${inputPath.replace(/\\/g, '\\\\')}');
  const pdfDoc = await PDFDocument.load(inputData);
  const pages = pdfDoc.getPages();
  
  if (pages.length < ${pageNum}) throw new Error('Page does not exist');
  const page = pages[${pageNum - 1}];
  const { height } = page.getSize();
  
  const font = await pdfDoc.embedFont(StandardFonts.Cursive);
  page.drawText('${args.signature_value.replace(/'/g, "\\'")}', {
    x: ${x}, y: height - ${y}, size: ${width / 3}, font,
  });
  
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync('${outputPath.replace(/\\/g, '\\\\')}', Buffer.from(pdfBytes));
  console.log('Signature added');
}).catch(err => { console.error(err); process.exit(1); });`;
  
  try {
    await runPdfLibScript(script);
    return { success: true, output_file: outputPath, message: `Signature added to page ${pageNum}` };
  } catch (err) {
    throw new Error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pdf_add_text(args: {
  input_file: string;
  output_file: string;
  text: string;
  page_numbers?: string;
  x_position?: number;
  y_position?: number;
  font_size?: number;
  font_color?: string;
}, _ctx: unknown): Promise<unknown> {
  ensureDirectories();
  
  const inputPath = ensureInputFile(args.input_file);
  const outputPath = getOutputPath(args.output_file || 'with_text.pdf');
  const x = args.x_position || 100;
  const y = args.y_position || 700;
  const size = args.font_size || 12;
  const color = hexToRgb(args.font_color || '#000000');
  
  const script = `
import('pdf-lib').then(async ({ PDFDocument, StandardFonts }) => {
  const fs = await import('fs');
  const inputData = fs.readFileSync('${inputPath.replace(/\\/g, '\\\\')}');
  const pdfDoc = await PDFDocument.load(inputData);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  
  pages.forEach(page => {
    page.drawText(\`${args.text.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`, {
      x: ${x}, y: ${y}, size: ${size}, font,
      color: { r: ${color.r/255}, g: ${color.g/255}, b: ${color.b/255}, type: 'RGB' },
    });
  });
  
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync('${outputPath.replace(/\\/g, '\\\\')}', Buffer.from(pdfBytes));
  console.log('Text added');
}).catch(err => { console.error(err); process.exit(1); });`;
  
  try {
    await runPdfLibScript(script);
    return { success: true, output_file: outputPath, message: 'Text added to PDF' };
  } catch (err) {
    throw new Error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pdf_add_watermark(args: {
  input_file: string;
  output_file: string;
  watermark_type: 'text' | 'image';
  watermark_value: string;
  page_numbers?: string;
  opacity?: number;
  rotation?: number;
  font_size?: number;
  color?: string;
}, _ctx: unknown): Promise<unknown> {
  ensureDirectories();
  
  const inputPath = ensureInputFile(args.input_file);
  const outputPath = getOutputPath(args.output_file || 'watermarked.pdf');
  const opacity = args.opacity || 0.3;
  const rotation = args.rotation || 45;
  const size = args.font_size || 60;
  const color = hexToRgb(args.color || '#CCCCCC');
  
  const script = `
import('pdf-lib').then(async ({ PDFDocument, StandardFonts, degrees }) => {
  const fs = await import('fs');
  const inputData = fs.readFileSync('${inputPath.replace(/\\/g, '\\\\')}');
  const pdfDoc = await PDFDocument.load(inputData);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  
  pages.forEach(page => {
    const { width, height } = page.getSize();
    page.drawText('${args.watermark_value.replace(/'/g, "\\'")}', {
      x: width / 2 - 100, y: height / 2, size: ${size}, font,
      color: { r: ${color.r/255}, g: ${color.g/255}, b: ${color.b/255}, type: 'RGB' },
      opacity: ${opacity}, rotate: degrees(${rotation}),
    });
  });
  
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync('${outputPath.replace(/\\/g, '\\\\')}', Buffer.from(pdfBytes));
  console.log('Watermark added');
}).catch(err => { console.error(err); process.exit(1); });`;
  
  try {
    await runPdfLibScript(script);
    return { success: true, output_file: outputPath, message: 'Watermark added' };
  } catch (err) {
    throw new Error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pdf_add_image(args: {
  input_file: string;
  output_file: string;
  image_path: string;
  page_number?: number;
  x_position?: number;
  y_position?: number;
  width?: number;
  height?: number;
}, _ctx: unknown): Promise<unknown> {
  ensureDirectories();
  
  const inputPath = ensureInputFile(args.input_file);
  const outputPath = getOutputPath(args.output_file || 'with_image.pdf');
  const imgPath = path.isAbsolute(args.image_path) ? args.image_path : path.join(WORKSPACE_DIR, args.image_path);
  const pageNum = args.page_number || 1;
  const x = args.x_position || 100;
  const y = args.y_position || 500;
  const width = args.width || 200;
  
  if (!fs.existsSync(imgPath)) throw new Error(`Image not found: ${imgPath}`);
  
  const imageData = fs.readFileSync(imgPath).toString('base64');
  const isPng = imgPath.toLowerCase().endsWith('.png');
  
  const script = isPng ? `
import('pdf-lib').then(async ({ PDFDocument }) => {
  const fs = await import('fs');
  const inputData = fs.readFileSync('${inputPath.replace(/\\/g, '\\\\')}');
  const pdfDoc = await PDFDocument.load(inputData);
  const pages = pdfDoc.getPages();
  if (pages.length < ${pageNum}) throw new Error('Page does not exist');
  const page = pages[${pageNum - 1}];
  const imageData = Buffer.from('${imageData}', 'base64');
  const image = await pdfDoc.embedPng(imageData);
  const dims = image.scale(${width} / image.width);
  page.drawImage('img', { x: ${x}, y: ${y}, width: dims.width, });
  const pdfBytes = await pdfDoc.save();
  height: dims.height fs.writeFileSync('${outputPath.replace(/\\/g, '\\\\')}', Buffer.from(pdfBytes));
  console.log('Image added');
}).catch(err => { console.error(err); process.exit(1); });` : `
import('pdf-lib').then(async ({ PDFDocument }) => {
  const fs = await import('fs');
  const inputData = fs.readFileSync('${inputPath.replace(/\\/g, '\\\\')}');
  const pdfDoc = await PDFDocument.load(inputData);
  const pages = pdfDoc.getPages();
  if (pages.length < ${pageNum}) throw new Error('Page does not exist');
  const page = pages[${pageNum - 1}];
  const imageData = Buffer.from('${imageData}', 'base64');
  const image = await pdfDoc.embedJpg(imageData);
  const dims = image.scale(${width} / image.width);
  page.drawImage('img', { x: ${x}, y: ${y}, width: dims.width, height: dims.height });
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync('${outputPath.replace(/\\/g, '\\\\')}', Buffer.from(pdfBytes));
  console.log('Image added');
}).catch(err => { console.error(err); process.exit(1); });`;
  
  try {
    await runPdfLibScript(script);
    return { success: true, output_file: outputPath, message: `Image added to page ${pageNum}` };
  } catch (err) {
    throw new Error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pdf_rotate_pages(args: {
  input_file: string;
  output_file: string;
  page_rotation: string;
}, _ctx: unknown): Promise<unknown> {
  ensureDirectories();
  
  const inputPath = ensureInputFile(args.input_file);
  const outputPath = getOutputPath(args.output_file || 'rotated.pdf');
  
  const pageRotations: Array<{ page: number; rotation: number }> = [];
  const specs = args.page_rotation.split(',');
  
  for (const spec of specs) {
    const [pagePart, rotationPart] = spec.trim().split(':');
    const rotation = rotationPart ? parseInt(rotationPart, 10) : 90;
    if (pagePart.toLowerCase() === 'all') {
      const pageCount = getPdfPageCount(inputPath);
      for (let i = 1; i <= pageCount; i++) pageRotations.push({ page: i, rotation });
    } else if (pagePart.includes('-')) {
      const [start, end] = pagePart.split('-').map(Number);
      for (let i = start; i <= end; i++) pageRotations.push({ page: i, rotation });
    } else {
      pageRotations.push({ page: parseInt(pagePart, 10), rotation });
    }
  }
  
  const script = `
import('pdf-lib').then(async ({ PDFDocument, degrees }) => {
  const fs = await import('fs');
  const inputData = fs.readFileSync('${inputPath.replace(/\\/g, '\\\\')}');
  const pdfDoc = await PDFDocument.load(inputData);
  const pages = pdfDoc.getPages();
  const rotations = ${JSON.stringify(pageRotations)};
  rotations.forEach(({ page, rotation }) => {
    if (pages[page - 1]) {
      const current = pages[page - 1].getRotation().angle;
      pages[page - 1].setRotation(degrees(current + rotation));
    }
  });
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync('${outputPath.replace(/\\/g, '\\\\')}', Buffer.from(pdfBytes));
  console.log('Pages rotated');
}).catch(err => { console.error(err); process.exit(1); });`;
  
  try {
    await runPdfLibScript(script);
    return { success: true, output_file: outputPath, message: `${pageRotations.length} pages rotated` };
  } catch (err) {
    throw new Error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pdf_compress(_args: {
  input_file: string;
  output_file: string;
  quality?: 'low' | 'medium' | 'high';
}, _ctx: unknown): Promise<unknown> {
  return {
    success: false,
    message: 'PDF compression requires Ghostscript. Install: sudo apt install ghostscript',
    alternative: 'Use online tools like ilovepdf.com for compression',
  };
}

export async function word_to_pdf(args: {
  input_file: string;
  output_file?: string;
}, _ctx: unknown): Promise<unknown> {
  ensureDirectories();
  
  const inputPath = ensureInputFile(args.input_file);
  const outputName = args.output_file || args.input_file.replace(/\.docx?$/i, '.pdf');
  const outputPath = getOutputPath(outputName);
  
  const sofficeCmds = ['soffice', '/usr/bin/soffice', 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'];
  let soffice = '';
  
  for (const cmd of sofficeCmds) {
    try {
      soffice = cmd;
      break;
    } catch { /* continue */ }
  }
  
  if (soffice) {
    const tempDir = path.join(PDF_TEMP_DIR, `doc_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.copyFileSync(inputPath, path.join(tempDir, path.basename(inputPath)));
    
    try {
      await runCommand(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, path.join(tempDir, path.basename(inputPath))]);
      const converted = path.join(tempDir, path.basename(inputPath, path.extname(inputPath)) + '.pdf');
      if (fs.existsSync(converted)) {
        fs.copyFileSync(converted, outputPath);
        fs.rmSync(tempDir, { recursive: true });
        return { success: true, input_file: inputPath, output_file: outputPath, message: 'Converted Word to PDF' };
      }
    } catch { fs.rmSync(tempDir, { recursive: true }); }
  }
  
  return {
    success: false,
    message: 'LibreOffice not found',
    install: { ubuntu: 'sudo apt install libreoffice', mac: 'brew install libreoffice', windows: 'Download from libreoffice.org' },
  };
}

export async function pdf_to_word(args: {
  input_file: string;
  output_file?: string;
}, _ctx: unknown): Promise<unknown> {
  ensureDirectories();
  
  const inputPath = ensureInputFile(args.input_file);
  const outputName = args.output_file || args.input_file.replace(/\.pdf$/i, '.docx');
  const outputPath = getOutputPath(outputName);
  
  const sofficeCmds = ['soffice', '/usr/bin/soffice', 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'];
  let soffice = '';
  
  for (const cmd of sofficeCmds) {
    try {
      soffice = cmd;
      break;
    } catch { /* continue */ }
  }
  
  if (soffice) {
    const tempDir = path.join(PDF_TEMP_DIR, `pdf_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.copyFileSync(inputPath, path.join(tempDir, path.basename(inputPath)));
    
    try {
      await runCommand(soffice, ['--headless', '--convert-to', 'docx', '--outdir', tempDir, path.join(tempDir, path.basename(inputPath))]);
      const converted = path.join(tempDir, path.basename(inputPath, path.extname(inputPath)) + '.docx');
      if (fs.existsSync(converted)) {
        fs.copyFileSync(converted, outputPath);
        fs.rmSync(tempDir, { recursive: true });
        return { success: true, input_file: inputPath, output_file: outputPath, message: 'Converted PDF to Word' };
      }
    } catch { fs.rmSync(tempDir, { recursive: true }); }
  }
  
  return {
    success: false,
    message: 'LibreOffice not found. Use online tools like ilovepdf.com for conversion',
    install: { ubuntu: 'sudo apt install libreoffice', mac: 'brew install libreoffice', windows: 'Download from libreoffice.org' },
  };
}

export async function pdf_info(args: { input_file: string }, _ctx: unknown): Promise<unknown> {
  const inputPath = ensureInputFile(args.input_file);
  const stats = fs.statSync(inputPath);
  const pageCount = getPdfPageCount(inputPath);
  
  return {
    file: path.basename(inputPath),
    size_bytes: stats.size,
    size_formatted: `${(stats.size / 1024).toFixed(2)} KB`,
    pages: pageCount,
  };
}

export async function pdf_list_pages(args: { input_file: string }, _ctx: unknown): Promise<unknown> {
  const inputPath = ensureInputFile(args.input_file);
  const pageCount = getPdfPageCount(inputPath);
  
  return { total_pages: pageCount, pages: Array.from({ length: pageCount }, (_, i) => ({ page_number: i + 1 })) };
}

export async function pdf_reorder_pages(args: {
  input_file: string;
  output_file: string;
  new_order: string;
}, _ctx: unknown): Promise<unknown> {
  ensureDirectories();
  
  const inputPath = ensureInputFile(args.input_file);
  const outputPath = getOutputPath(args.output_file || 'reordered.pdf');
  const pageOrder = args.new_order.split(',').map(n => parseInt(n.trim(), 10));
  const maxPage = getPdfPageCount(inputPath);
  
  if (pageOrder.some(p => p < 1 || p > maxPage)) throw new Error(`Invalid page number. PDF has ${maxPage} pages.`);
  
  const script = `
import('pdf-lib').then(async ({ PDFDocument }) => {
  const fs = await import('fs');
  const inputData = fs.readFileSync('${inputPath.replace(/\\/g, '\\\\')}');
  const pdfDoc = await PDFDocument.load(inputData);
  const newPdf = await PDFDocument.create();
  const order = ${JSON.stringify(pageOrder.map(p => p - 1))};
  const copied = await newPdf.copyPages(pdfDoc, order);
  copied.forEach(p => newPdf.addPage(p));
  const pdfBytes = await newPdf.save();
  fs.writeFileSync('${outputPath.replace(/\\/g, '\\\\')}', Buffer.from(pdfBytes));
  console.log('Pages reordered');
}).catch(err => { console.error(err); process.exit(1); });`;
  
  try {
    await runPdfLibScript(script);
    return { success: true, output_file: outputPath, message: `Reordered to: ${args.new_order}` };
  } catch (err) {
    throw new Error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pdf_remove_pages(args: {
  input_file: string;
  output_file: string;
  pages_to_remove: string;
}, _ctx: unknown): Promise<unknown> {
  ensureDirectories();
  
  const inputPath = ensureInputFile(args.input_file);
  const outputPath = getOutputPath(args.output_file || 'modified.pdf');
  const pageCount = getPdfPageCount(inputPath);
  const removePages = parsePageSpec(args.pages_to_remove, pageCount);
  const keepPages: number[] = [];
  for (let i = 1; i <= pageCount; i++) if (!removePages.includes(i)) keepPages.push(i - 1);
  
  const script = `
import('pdf-lib').then(async ({ PDFDocument }) => {
  const fs = await import('fs');
  const inputData = fs.readFileSync('${inputPath.replace(/\\/g, '\\\\')}');
  const pdfDoc = await PDFDocument.load(inputData);
  const newPdf = await PDFDocument.create();
  const keep = ${JSON.stringify(keepPages)};
  const copied = await newPdf.copyPages(pdfDoc, keep);
  copied.forEach(p => newPdf.addPage(p));
  const pdfBytes = await newPdf.save();
  fs.writeFileSync('${outputPath.replace(/\\/g, '\\\\')}', Buffer.from(pdfBytes));
  console.log('Pages removed');
}).catch(err => { console.error(err); process.exit(1); });`;
  
  try {
    await runPdfLibScript(script);
    return { success: true, output_file: outputPath, message: `Removed pages: ${args.pages_to_remove}. Remaining: ${keepPages.length}` };
  } catch (err) {
    throw new Error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
