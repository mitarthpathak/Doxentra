// Synthetic extractions for validation tests (no real data).
import { normalizeExtraction } from '../../lib/extract.js';

// Later entries replace earlier ones with the same key.
const merge = (base, overrides) => [...base.filter(b => !overrides.some(o => o.key === b.key)), ...overrides];
const fld = (key, value, extra = {}) => ({ key, label: key, value, confidence: 0.9, page: 1, sourceQuote: value == null ? null : `${key}: ${value}`, ...extra });

export function invoiceDoc({ total = 'Rs. 1,180.00', gstin = '27AAACE1234F1Z6', rows, fields = [] } = {}) {
  return normalizeExtraction({
    docType: 'invoice', docTypeConfidence: 0.95, summary: 'Synthetic invoice.',
    fields: merge([
      fld('invoice_number', 'INV-1'), fld('invoice_date', '12/03/2024'), fld('due_date', '27/03/2024'),
      fld('seller_name', 'Example Traders Pvt Ltd'), fld('seller_gstin', gstin), fld('buyer_name', 'Sample Retail Co'),
      fld('subtotal', 'Rs. 1,000.00'), fld('cgst', 'Rs. 90.00'), fld('sgst', 'Rs. 90.00'), fld('tax_total', 'Rs. 180.00'),
      fld('total_amount', total),
    ], fields),
    entities: [],
    tables: [{ title: 'Items', columns: ['Item', 'Qty', 'Rate', 'Amount'], rows: rows || [['Notebook', '10', '50.00', '500.00'], ['Pen set', '5', '100.00', '500.00']] }],
  });
}

export function marksheetDoc({ total = '412', percentage = '82.4', result = 'PASS', rows } = {}) {
  return normalizeExtraction({
    docType: 'marksheet', docTypeConfidence: 0.95, summary: 'Synthetic marksheet.',
    fields: [
      fld('student_name', 'Asha Verma'), fld('roll_number', '1234567'), fld('institution_name', 'Model Senior Secondary School'),
      fld('examination', 'Senior Secondary Examination 2024'), fld('total_marks_obtained', total), fld('total_max_marks', '500'),
      fld('percentage', percentage), fld('result', result),
    ],
    entities: [],
    tables: [{ title: 'Marks', columns: ['Subject', 'Max Marks', 'Marks Obtained'], rows: rows || [
      ['English', '100', '85'], ['Hindi', '100', '78'], ['Mathematics', '100', '90'], ['Science', '100', '81'], ['Social Science', '100', '78'],
    ] }],
  });
}

export function certificateDoc({ issue = '15/06/2024', valid = '14/06/2026', recipient = 'Rohan Mehta', entities = [] } = {}) {
  return normalizeExtraction({
    docType: 'certificate', docTypeConfidence: 0.92, summary: 'Synthetic certificate.',
    fields: [
      fld('certificate_title', 'Certificate of Completion'), fld('recipient_name', recipient),
      fld('issuing_organization', 'Example Institute of Technology'), fld('issue_date', issue), fld('valid_until', valid),
    ],
    entities,
    tables: [],
  });
}
