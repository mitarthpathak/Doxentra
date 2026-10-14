import { writeFile } from 'node:fs/promises';
import { makePdf } from '../server/test/helpers/files.js';

async function pdf(filename, title, lines) {
  await writeFile(new URL(`../samples/${filename}`, import.meta.url), makePdf([[title, ...lines]]));
}

const common = ['Invoice No: DOXENTRA-DEMO-042', 'Invoice Date: 12/10/2026', 'Seller: Example Traders Pvt Ltd',
  'Seller GSTIN: 27AAACE1234F1Z6', 'Buyer: Demo Learning Centre', 'Subtotal: Rs. 25,000.00',
  'CGST: Rs. 1,750.00', 'SGST: Rs. 1,750.00'];
await pdf('workflow-invoice-v1.pdf', 'Tax Invoice - Original', [...common.slice(0, 5),
  'Subtotal: Rs. 16,500.00', 'CGST: Rs. 1,000.00', 'SGST: Rs. 1,000.00',
  'Total Amount: Rs. 18,500.00', 'Bank Account No: 123456789012', 'Bank IFSC: HDFC0001234']);
await pdf('workflow-invoice-v2.pdf', 'Tax Invoice - Revised', [...common,
  'Total Amount: Rs. 28,500.00', 'Bank Account No: 987654321098', 'Bank IFSC: HDFC0001234']);
await pdf('workflow-eligibility-circular.pdf', 'Scholarship Eligibility Circular', [
  'Reference No: DOXENTRA/SCHOLARSHIP/2026/04', 'Issued by: Demo Learning Centre',
  'Applicants must submit a marksheet.', 'Applicants must submit a certificate.',
  'The certificate must remain valid through 31/12/2026.',
  'Reviewers must verify document details against the original pages.',
]);
