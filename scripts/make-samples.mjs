// Generates the SYNTHETIC sample documents in samples/ (no real people or
// organisations; IDs only follow the official formats). HTML is printed to PDF
// with Playwright; "scans" are screenshots that are rotated, blurred and
// given noise in a canvas, then saved as JPEG (or wrapped in an image-only PDF).
// Usage: node scripts/make-samples.mjs [letters...]   (e.g. `i j` regenerates only those samples)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadChromium } from './lib/browser.mjs';

const OUT = 'samples';
mkdirSync(OUT, { recursive: true });

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { font-family: 'Liberation Sans', 'FreeSans', Arial, sans-serif; color: #1f2937; margin: 0; font-size: 12.5px; }
  .page { width: 794px; min-height: 1123px; padding: 56px 60px; background: #fff; position: relative; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: .5px; }
  h2 { font-size: 15px; margin: 18px 0 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #9ca3af; padding: 6px 8px; text-align: left; }
  th { background: #f3f4f6; }
  td.num, th.num { text-align: right; }
  .muted { color: #6b7280; }
  .row { display: flex; justify-content: space-between; gap: 24px; }
  .box { border: 1px solid #9ca3af; padding: 10px 12px; }
  .totals td { border: none; padding: 3px 8px; }
  .sig { margin-top: 48px; text-align: right; }
  .stamp { display: inline-block; border: 2px solid #1d4ed8; color: #1d4ed8; border-radius: 50%; padding: 18px 10px; transform: rotate(-12deg); font-size: 10px; font-weight: bold; }
`;
const page = (body, css = '') => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body><div class="page">${body}</div></body></html>`;

// ─── (a) digital invoice, correct maths ──────────────────────────────
const invoiceOk = page(`
  <div class="row">
    <div><h1>TAX INVOICE</h1><div class="muted">Original for Recipient</div></div>
    <div style="text-align:right"><b>Example Traders Pvt Ltd</b><br>14 Sample Industrial Estate, Pune, Maharashtra 411019<br>GSTIN: 27AAACE1234F1Z6<br>PAN: AAACE1234F<br>accounts@example.com</div>
  </div>
  <div class="row" style="margin-top:20px">
    <div class="box" style="flex:1"><b>Bill To:</b> Sample Retail Co<br>22 Demo Market, Mumbai 400001<br>Buyer GSTIN: 27AAFCS5678B1Z7<br>Place of Supply: Maharashtra (27)</div>
    <div class="box" style="flex:1">Invoice No: ET/2024-25/0147<br>Invoice Date: 15/07/2024<br>Due Date: 14/08/2024<br>Payment Terms: Net 30</div>
  </div>
  <table>
    <tr><th>#</th><th>Description</th><th>HSN</th><th class="num">Qty</th><th class="num">Rate (₹)</th><th class="num">Amount (₹)</th></tr>
    <tr><td>1</td><td>A4 Copier Paper (500 sheets)</td><td>4802</td><td class="num">20</td><td class="num">250.00</td><td class="num">5,000.00</td></tr>
    <tr><td>2</td><td>Whiteboard Markers (pack of 10)</td><td>9608</td><td class="num">15</td><td class="num">180.00</td><td class="num">2,700.00</td></tr>
    <tr><td>3</td><td>Ergonomic Office Chair</td><td>9401</td><td class="num">2</td><td class="num">4,150.00</td><td class="num">8,300.00</td></tr>
  </table>
  <table class="totals" style="width:320px;margin-left:auto">
    <tr><td>Subtotal</td><td class="num">₹ 16,000.00</td></tr>
    <tr><td>CGST @ 9%</td><td class="num">₹ 1,440.00</td></tr>
    <tr><td>SGST @ 9%</td><td class="num">₹ 1,440.00</td></tr>
    <tr><td><b>Total</b></td><td class="num"><b>₹ 18,880.00</b></td></tr>
  </table>
  <p>Amount in words: Rupees Eighteen Thousand Eight Hundred Eighty Only</p>
  <p class="muted">Bank: Demo Bank, A/c 000123456789, IFSC DEMO0001234</p>
  <div class="sig">For Example Traders Pvt Ltd<br><br><span class="stamp">EXAMPLE<br>TRADERS</span><br>Authorised Signatory</div>
`);

// ─── (b) invoice with a total mismatch and no GSTIN ──────────────────
const invoiceBad = page(`
  <h1>TAX INVOICE</h1>
  <p><b>Sample Office Supplies</b><br>5 Demo Lane, Bengaluru, Karnataka 560001<br>Phone: 98765 43210</p>
  <div class="row">
    <div class="box" style="flex:1"><b>Bill To:</b> Demo Learning Centre<br>9 Example Street, Mysuru 570001</div>
    <div class="box" style="flex:1">Invoice No: SOS-2024-0912<br>Invoice Date: 03/09/2024<br>Due Date: 18/09/2024</div>
  </div>
  <table>
    <tr><th>Item</th><th class="num">Qty</th><th class="num">Rate (₹)</th><th class="num">Amount (₹)</th></tr>
    <tr><td>Printer Toner Cartridge</td><td class="num">4</td><td class="num">1,500.00</td><td class="num">6,000.00</td></tr>
    <tr><td>Stapler (heavy duty)</td><td class="num">5</td><td class="num">300.00</td><td class="num">1,500.00</td></tr>
    <tr><td>Box Files</td><td class="num">40</td><td class="num">50.00</td><td class="num">2,000.00</td></tr>
  </table>
  <table class="totals" style="width:320px;margin-left:auto">
    <tr><td>Subtotal</td><td class="num">₹ 9,500.00</td></tr>
    <tr><td>CGST @ 9%</td><td class="num">₹ 855.00</td></tr>
    <tr><td>SGST @ 9%</td><td class="num">₹ 855.00</td></tr>
    <tr><td><b>Grand Total</b></td><td class="num"><b>₹ 11,710.00</b></td></tr>
  </table>
  <div class="sig">Authorised Signatory</div>
`);

// ─── (c) certificate issued after its expiry date ────────────────────
const certificate = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  .cert { width: 1123px; height: 794px; padding: 50px; background: #fffdf7; font-family: 'FreeSerif', serif; text-align: center; position: relative; }
  .frame { border: 6px double #92400e; height: 100%; padding: 40px 60px; }
  .name { font-size: 36px; font-style: italic; margin: 18px 0; }
  .meta { display: flex; justify-content: space-between; margin-top: 50px; font-size: 14px; text-align: left; }
</style></head><body><div class="cert"><div class="frame">
  <div style="font-size:16px;letter-spacing:3px">EXAMPLE INSTITUTE OF TECHNOLOGY, PUNE</div>
  <h1 style="font-size:40px;margin-top:20px;font-family:FreeSerif">Certificate of Completion</h1>
  <p style="font-size:16px">This is to certify that</p>
  <div class="name">Rohan Mehta</div>
  <p style="font-size:16px">has successfully completed the 120-hour course <b>Full Stack Web Development</b><br>with Grade <b>A</b>.</p>
  <div class="meta">
    <div>Certificate No: EIT/FSWD/2024/0381<br>Date of Issue: 20/08/2024<br>Valid Until: 19/08/2023</div>
    <div style="text-align:center"><span class="stamp" style="border-color:#92400e;color:#92400e">EIT<br>SEAL</span></div>
    <div style="text-align:right">Dr. Kavita Rao<br>Director, Academic Programmes</div>
  </div>
  <p class="muted" style="font-size:11px;margin-top:30px">Verification: issued to Mr. Rohan Mehtaa. Verify at verify.example.edu with the certificate number.</p>
</div></div></body></html>`;

// ─── (d) marksheet whose total does not match the subjects ───────────
const marksheet = page(`
  <div style="text-align:center">
    <div style="font-size:13px">SAMPLE BOARD OF SCHOOL EDUCATION</div>
    <h1>Model Senior Secondary School</h1>
    <div>Statement of Marks — Annual Examination 2024</div>
    <div class="muted">Class XII · Session 2023-24</div>
  </div>
  <table style="margin-top:20px">
    <tr><td>Name of Student: <b>Asha Verma</b></td><td>Roll No: 2401587</td></tr>
    <tr><td>Father's Name: Suresh Verma</td><td>Date of Birth: 14/02/2006</td></tr>
  </table>
  <table style="margin-top:16px">
    <tr><th>Subject</th><th class="num">Max Marks</th><th class="num">Marks Obtained</th><th>Grade</th></tr>
    <tr><td>English</td><td class="num">100</td><td class="num">85</td><td>A2</td></tr>
    <tr><td>Hindi</td><td class="num">100</td><td class="num">78</td><td>B1</td></tr>
    <tr><td>Mathematics</td><td class="num">100</td><td class="num">91</td><td>A1</td></tr>
    <tr><td>Physics</td><td class="num">100</td><td class="num">74</td><td>B1</td></tr>
    <tr><td>Chemistry</td><td class="num">100</td><td class="num">80</td><td>A2</td></tr>
  </table>
  <table class="totals" style="width:360px;margin-left:auto;margin-top:12px">
    <tr><td>Grand Total</td><td class="num"><b>418 / 500</b></td></tr>
    <tr><td>Percentage</td><td class="num">83.60%</td></tr>
    <tr><td>Result</td><td class="num"><b>PASS</b></td></tr>
  </table>
  <p>Date of Declaration: 15/05/2024</p>
  <div class="sig">Controller of Examinations</div>
`);

// ─── (e) filled application form (scanned photo) ─────────────────────
const hand = 'font-family: FreeSerif, serif; font-style: italic; color: #1e3a8a; font-size: 15px;';
const formLine = (label, value) => `<tr><td style="width:36%;border:none;padding:9px 0">${label}</td><td style="border:none;border-bottom:1px solid #6b7280;${hand}">${value}</td></tr>`;
const form = page(`
  <div style="text-align:center"><b>EXAMPLE COLLEGE OF ARTS AND SCIENCE, NAGPUR</b><h1 style="margin-top:6px">Admission Application Form</h1><div>Session 2024-25</div></div>
  <p>Application No: <span style="${hand}">ADM/2024/1093</span></p>
  <table>
    ${formLine('Full name of applicant', 'Neha Rao')}
    ${formLine('Date of birth (DD/MM/YYYY)', '05/09/2006')}
    ${formLine('Gender', 'Female')}
    ${formLine("Father's name", 'Prakash Rao')}
    ${formLine('Email', 'neha.rao@example.com')}
    ${formLine('Mobile', '98765 43210')}
    ${formLine('Address', '7 Demo Colony, Nagpur, Maharashtra')}
    ${formLine('PIN code', '440010')}
    ${formLine('Course applied for', 'B.Sc. Computer Science')}
    ${formLine('Aadhaar No.', 'XXXX XXXX 4321')}
  </table>
  <p style="margin-top:24px">I declare that the information given above is true.</p>
  <div class="row"><div>Date: <span style="${hand}">28/06/2024</span></div><div>Signature of applicant: <span style="${hand}font-size:22px">N. Rao</span></div></div>
`);

// ─── (f) student ID card (scanned, image-only PDF) ───────────────────
const idCard = page(`
  <div style="width:520px;margin:120px auto;border:2px solid #0f766e;border-radius:14px;overflow:hidden">
    <div style="background:#0f766e;color:#fff;padding:12px 16px"><b style="font-size:18px">EXAMPLE UNIVERSITY</b><br>Student Identity Card</div>
    <div style="display:flex;gap:16px;padding:16px">
      <div style="width:110px;height:130px;background:#e5e7eb;display:flex;align-items:center;justify-content:center" class="muted">PHOTO</div>
      <div style="line-height:1.8">
        Name: <b>Arjun Nair</b><br>Enrollment No: EU2023CS0412<br>Programme: B.Tech Computer Science<br>
        Date of Birth: 11/11/2004<br>Blood Group: O+<br>Date of Issue: 01/08/2023<br>Valid Till: 31/07/2027
      </div>
    </div>
    <div style="padding:0 16px 14px" class="muted">Address: 3 Sample Hostel Road, Kochi, Kerala 682001<br>If found, please return to the Registrar, Example University.</div>
  </div>
`);

// ─── (g) bilingual Hindi + English notice ────────────────────────────
const notice = page(`
  <div style="text-align:center">
    <h1 style="font-family:FreeSans">आदर्श पब्लिक स्कूल / Model Public School</h1>
    <div>12 Demo Road, Jaipur, Rajasthan 302001</div>
    <h2 style="font-size:20px;text-decoration:underline">सूचना / NOTICE</h2>
  </div>
  <div class="row"><div>Ref No: MPS/ADM/2024/112</div><div>दिनांक / Date: 02/01/2024</div></div>
  <p><b>विषय: वार्षिक परीक्षा कार्यक्रम / Subject: Annual Examination Schedule</b></p>
  <p style="font-family:FreeSans;font-size:14px;line-height:1.7">सभी छात्रों एवं अभिभावकों को सूचित किया जाता है कि वार्षिक परीक्षा 15/03/2024 से प्रारंभ होगी। परीक्षा शुल्क जमा करने की अंतिम तिथि 20/02/2024 है। प्रवेश पत्र 05/03/2024 से कार्यालय से प्राप्त किए जा सकते हैं।</p>
  <p style="line-height:1.7">All students and parents are informed that the annual examinations will begin on 15/03/2024. The last date for depositing the examination fee is 20/02/2024. Admit cards can be collected from the office from 05/03/2024.</p>
  <div class="sig">प्रधानाचार्य / Principal<br>Dr. S. Iyer<br>Model Public School</div>
  <p class="muted">To: All students of Classes IX to XII and their parents</p>
`);

// ─── (h) report with an unusual layout ───────────────────────────────
const report = page(`
  <div style="position:absolute;left:8px;top:300px;transform:rotate(-90deg);transform-origin:left top;font-size:22px;letter-spacing:6px;color:#9ca3af">QUARTERLY INSPECTION</div>
  <div style="margin-left:40px">
    <div class="row" style="align-items:flex-end;border-bottom:3px solid #111827;padding-bottom:8px">
      <div><div class="muted">Estates Department · Example University</div><h1>Campus Facilities Inspection Report</h1></div>
      <div style="text-align:right">Report No: CFI/Q2/2024/07<br>Date: 05/07/2024</div>
    </div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:24px;margin-top:16px">
      <div style="columns:2;column-gap:20px;line-height:1.6">
        <p><b>Period covered:</b> April to June 2024. Prepared by the Estates Department for the Registrar.</p>
        <h2>Findings</h2>
        <p>1. Three classrooms in Block A have faulty projectors.</p>
        <p>2. Fire extinguishers in Block C are due for refill.</p>
        <p>3. Water purifier maintenance in the main canteen is overdue by six weeks.</p>
        <h2>Recommendations</h2>
        <p>Replace the projectors before the new semester, refill all extinguishers within 15 days and sign an annual maintenance contract for water purifiers.</p>
        <h2>Conclusion</h2>
        <p>Facilities are largely in good condition; the safety items need urgent attention.</p>
      </div>
      <div class="box" style="background:#f9fafb">
        <b>Key figures</b>
        <table><tr><td>Buildings inspected</td><td class="num">6</td></tr><tr><td>Issues found</td><td class="num">3</td></tr><tr><td>Estimated cost</td><td class="num">₹ 1,25,000</td></tr></table>
        <p class="muted" style="margin-top:12px">Inspector: Ms. Farah Khan</p>
      </div>
    </div>
  </div>
`);

// ─── (i) student ID card for the marksheet's student, with conflicting details ─
// Cross-document check: same roll number as the marksheet (d), but a different
// date of birth and the father's name spelt differently.
const idCardAsha = page(`
  <div style="width:560px;margin:110px auto;border:2px solid #1d4ed8;border-radius:14px;overflow:hidden">
    <div style="background:#1d4ed8;color:#fff;padding:12px 16px"><b style="font-size:18px">MODEL SENIOR SECONDARY SCHOOL</b><br>Student Identity Card · Session 2024-25</div>
    <div style="display:flex;gap:16px;padding:16px">
      <div style="width:110px;height:130px;background:#e5e7eb;display:flex;align-items:center;justify-content:center" class="muted">PHOTO</div>
      <div style="line-height:1.8">
        Name: <b>Asha Verma</b><br>Father's Name: Suresh Varma<br>Date of Birth: 14/03/2006<br>
        Class: XII · Roll No: 2401587<br>Date of Issue: 01/04/2024<br>Valid Till: 31/03/2025
      </div>
    </div>
    <div style="padding:0 16px 14px" class="muted">Address: 18 Demo Nagar, Jaipur, Rajasthan 302004<br>Principal's signature on reverse.</div>
  </div>
`);

// ─── (j) a second invoice with the same number as (a) but different items ─
// Cross-document check: duplicate invoice number from the same seller, other total.
const invoiceDuplicate = page(`
  <div class="row">
    <div><h1>TAX INVOICE</h1><div class="muted">Duplicate for Transporter</div></div>
    <div style="text-align:right"><b>Example Traders Pvt Ltd</b><br>14 Sample Industrial Estate, Pune, Maharashtra 411019<br>GSTIN: 27AAACE1234F1Z6<br>accounts@example.com</div>
  </div>
  <div class="row" style="margin-top:20px">
    <div class="box" style="flex:1"><b>Bill To:</b> Sample Retail Co<br>22 Demo Market, Mumbai 400001<br>Buyer GSTIN: 27AAFCS5678B1Z7</div>
    <div class="box" style="flex:1">Invoice No: ET/2024-25/0147<br>Invoice Date: 15/07/2024<br>Due Date: 14/08/2024</div>
  </div>
  <table>
    <tr><th>#</th><th>Description</th><th class="num">Qty</th><th class="num">Rate (₹)</th><th class="num">Amount (₹)</th></tr>
    <tr><td>1</td><td>A4 Copier Paper (500 sheets)</td><td class="num">20</td><td class="num">250.00</td><td class="num">5,000.00</td></tr>
    <tr><td>2</td><td>Whiteboard Markers (pack of 10)</td><td class="num">15</td><td class="num">180.00</td><td class="num">2,700.00</td></tr>
    <tr><td>3</td><td>Ergonomic Office Chair</td><td class="num">2</td><td class="num">4,100.00</td><td class="num">8,200.00</td></tr>
  </table>
  <table class="totals" style="width:320px;margin-left:auto">
    <tr><td>Subtotal</td><td class="num">₹ 15,900.00</td></tr>
    <tr><td>CGST @ 9%</td><td class="num">₹ 1,431.00</td></tr>
    <tr><td>SGST @ 9%</td><td class="num">₹ 1,431.00</td></tr>
    <tr><td><b>Total</b></td><td class="num"><b>₹ 18,762.00</b></td></tr>
  </table>
  <div class="sig">For Example Traders Pvt Ltd<br><br>Authorised Signatory</div>
`);

// Seeded noise so the "scans" are reproducible.
const SCAN_JS = `async ({ src, angle, seed, quality, filter }) => {
  const img = new Image(); img.src = src; await img.decode();
  const w = img.width, h = img.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f1e8'; g.fillRect(0, 0, w, h);
  g.translate(w / 2, h / 2); g.rotate(angle * Math.PI / 180); g.translate(-w / 2, -h / 2);
  g.filter = filter;
  g.drawImage(img, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0); g.filter = 'none';
  const d = g.getImageData(0, 0, w, h); let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = 0; i < d.data.length; i += 4) {
    const n = (rnd() - 0.5) * 38;
    d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n - 4;
  }
  g.putImageData(d, 0, 0);
  return c.toDataURL('image/jpeg', quality);
}`;

const chromium = await loadChromium();
const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const p = await ctx.newPage();

async function pdf(name, html, landscape = false) {
  await p.setContent(html, { waitUntil: 'load' });
  await p.pdf({ path: `${OUT}/${name}`, format: 'A4', landscape, printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
}

async function scan(html, { angle, seed, quality = 0.72, scale = 2, filter = 'blur(0.6px) grayscale(0.6) contrast(1.1)' }) {
  const s = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: scale });
  await s.setContent(html, { waitUntil: 'load' });
  const png = await s.screenshot({ fullPage: false });
  await s.close();
  const dataUrl = await p.evaluate(new Function(`return (${SCAN_JS})`)(), { src: `data:image/png;base64,${png.toString('base64')}`, angle, seed, quality, filter });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// Only the samples named on the command line (by letter), or all of them.
// PDFs embed a creation date, so regenerating unchanged samples changes their hashes.
const only = new Set(process.argv.slice(2));
const want = name => !only.size || only.has(name[0]);
if (want('a')) await pdf('a-invoice-digital.pdf', invoiceOk);
if (want('b')) await pdf('b-invoice-total-mismatch.pdf', invoiceBad);
if (want('c')) await pdf('c-certificate-issued-after-expiry.pdf', certificate, true);
if (want('d')) await pdf('d-marksheet-wrong-total.pdf', marksheet);
if (want('e')) writeFileSync(`${OUT}/e-application-form-scan.jpg`, await scan(form, { angle: 1.6, seed: 7 }));
if (want('f')) {
  const idJpeg = await scan(idCard, { angle: -2.2, seed: 11, quality: 0.7 });
  await p.setContent(`<!doctype html><html><body style="margin:0"><img src="data:image/jpeg;base64,${idJpeg.toString('base64')}" style="width:210mm;height:297mm;display:block"></body></html>`, { waitUntil: 'load' });
  await p.pdf({ path: `${OUT}/f-student-id-scanned.pdf`, format: 'A4', margin: { top: '0', bottom: '0', left: '0', right: '0' } });
}
if (want('g')) await pdf('g-notice-bilingual-hindi-english.pdf', notice);
if (want('h')) await pdf('h-report-unusual-layout.pdf', report);
if (want('i')) await pdf('i-student-id-asha-verma.pdf', idCardAsha);
if (want('j')) await pdf('j-invoice-duplicate-number.pdf', invoiceDuplicate);
// The same form as e, photographed out of focus in dim light (image-quality warnings).
if (want('k')) writeFileSync(`${OUT}/k-application-form-blurry-photo.jpg`, await scan(form, { angle: -3.1, seed: 5, quality: 0.8, filter: 'blur(2.6px) grayscale(0.6) brightness(0.4) contrast(0.9)' }));
await browser.close();

// Manifest: which canned answer the mock API uses for each sample (by file hash).
const manifest = [
  ['a-invoice-digital.pdf', 'sample-a-invoice.json'],
  ['b-invoice-total-mismatch.pdf', 'sample-b-invoice-mismatch.json'],
  ['c-certificate-issued-after-expiry.pdf', 'sample-c-certificate.json'],
  ['d-marksheet-wrong-total.pdf', 'sample-d-marksheet.json'],
  ['e-application-form-scan.jpg', 'sample-e-form.json'],
  ['f-student-id-scanned.pdf', 'sample-f-id-card.json'],
  ['g-notice-bilingual-hindi-english.pdf', 'sample-g-notice.json'],
  ['h-report-unusual-layout.pdf', 'sample-h-report.json'],
  ['i-student-id-asha-verma.pdf', 'sample-i-id-card-asha.json'],
  ['j-invoice-duplicate-number.pdf', 'sample-j-invoice-duplicate.json'],
  ['k-application-form-blurry-photo.jpg', 'sample-e-form.json'],
].map(([file, fixture]) => {
  const buf = readFileSync(`${OUT}/${file}`);
  return { file, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), fixture };
});
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
for (const m of manifest) console.log(`${m.file.padEnd(42)} ${(m.bytes / 1024).toFixed(0).padStart(5)} KB`);
