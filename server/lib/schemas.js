/**
 * Predefined document types and the fields extracted for each.
 *
 * Field types: string | date | amount | number | id | email | phone | enum | list
 * `format` names a stricter check (see normalize.js FORMATS): pan, gstin,
 * pincode, ifsc, aadhaar. `aliases` are label variants seen on real documents
 * (also used by the rule-based fallback when the AI is unavailable).
 */

const f = (key, label, type, required, description, extra = {}) => ({ key, label, type, required, description, ...extra });

export const DOCUMENT_TYPES = [
  {
    id: 'invoice',
    label: 'Invoice',
    description: 'Tax invoice, bill, receipt or quotation with amounts (GST invoices in India).',
    keywords: ['invoice', 'tax invoice', 'bill to', 'gstin', 'hsn', 'sac', 'cgst', 'sgst', 'igst', 'amount due', 'grand total', 'receipt', 'बीजक'],
    entities: ['ORG', 'AMOUNT', 'DATE', 'ID', 'LOCATION'],
    fields: [
      f('invoice_number', 'Invoice number', 'id', true, 'Invoice / bill number', { aliases: ['invoice no', 'bill no', 'inv no', 'invoice #'] }),
      f('invoice_date', 'Invoice date', 'date', true, 'Date of issue', { aliases: ['date', 'bill date', 'dated'] }),
      f('due_date', 'Due date', 'date', false, 'Payment due date', { aliases: ['payment due'] }),
      f('seller_name', 'Seller', 'string', true, 'Business issuing the invoice', { aliases: ['from', 'supplier', 'vendor', 'sold by'] }),
      f('seller_gstin', 'Seller GSTIN', 'id', true, '15-character GSTIN of the seller', { format: 'gstin', aliases: ['gstin', 'gst no', 'gst number'] }),
      f('seller_pan', 'Seller PAN', 'id', false, 'PAN of the seller', { format: 'pan', aliases: ['pan', 'pan no'] }),
      f('seller_address', 'Seller address', 'string', false, 'Address of the seller'),
      f('buyer_name', 'Buyer', 'string', true, 'Customer billed', { aliases: ['bill to', 'billed to', 'customer', 'buyer', 'sold to'] }),
      f('buyer_gstin', 'Buyer GSTIN', 'id', false, 'GSTIN of the buyer if registered', { format: 'gstin' }),
      f('buyer_address', 'Buyer address', 'string', false, 'Billing address of the buyer'),
      f('place_of_supply', 'Place of supply', 'string', false, 'State / place of supply'),
      f('subtotal', 'Subtotal', 'amount', true, 'Taxable value before tax', { aliases: ['sub total', 'taxable value', 'taxable amount'] }),
      f('discount', 'Discount', 'amount', false, 'Total discount'),
      f('cgst', 'CGST', 'amount', false, 'Central GST amount'),
      f('sgst', 'SGST', 'amount', false, 'State GST amount'),
      f('igst', 'IGST', 'amount', false, 'Integrated GST amount'),
      f('tax_total', 'Total tax', 'amount', false, 'Sum of all taxes', { aliases: ['total tax', 'tax amount', 'gst'] }),
      f('total_amount', 'Total amount', 'amount', true, 'Grand total payable', { aliases: ['grand total', 'total', 'amount payable', 'total amount', 'net amount'] }),
      f('amount_in_words', 'Amount in words', 'string', false, 'Total written in words'),
      f('currency', 'Currency', 'enum', false, 'Currency code, INR for ₹ / Rs.', { options: ['INR', 'USD', 'EUR', 'GBP', 'OTHER'] }),
      f('payment_terms', 'Payment terms', 'string', false, 'Payment terms or bank details'),
      f('bank_account_number', 'Bank account number', 'id', false, 'Account number printed for payment', { aliases: ['account no', 'a/c no', 'bank account'] }),
      f('bank_ifsc', 'Bank IFSC', 'id', false, 'IFSC for the payment account', { format: 'ifsc', aliases: ['ifsc code', 'ifsc'] }),
    ],
  },
  {
    id: 'certificate',
    label: 'Certificate',
    description: 'Certificate of completion, participation, merit, character, registration, etc.',
    keywords: ['certificate', 'certify', 'certified', 'awarded', 'participation', 'completion', 'achievement', 'प्रमाण पत्र', 'प्रमाणित'],
    entities: ['PERSON', 'ORG', 'DATE', 'ID'],
    fields: [
      f('certificate_title', 'Certificate title', 'string', true, 'Title, e.g. "Certificate of Completion"'),
      f('certificate_number', 'Certificate number', 'id', false, 'Certificate / serial / registration number', { aliases: ['certificate no', 'serial no', 'cert no', 'reg no'] }),
      f('recipient_name', 'Recipient', 'string', true, 'Person the certificate is issued to', { aliases: ['awarded to', 'presented to', 'name'] }),
      f('issuing_organization', 'Issued by', 'string', true, 'Institution or organisation issuing it'),
      f('course_or_achievement', 'Course / achievement', 'string', false, 'What it certifies'),
      f('grade_or_score', 'Grade / score', 'string', false, 'Grade, score or distinction'),
      f('issue_date', 'Issue date', 'date', true, 'Date of issue', { aliases: ['date of issue', 'issued on', 'date'] }),
      f('valid_until', 'Valid until', 'date', false, 'Expiry / valid-till date', { aliases: ['valid till', 'valid upto', 'expiry date', 'expires on'] }),
      f('signatory_name', 'Signatory', 'string', false, 'Name of the signing authority'),
      f('signatory_designation', 'Signatory designation', 'string', false, 'Designation of the signing authority'),
      f('place', 'Place', 'string', false, 'Place of issue'),
      f('seal_or_signature_present', 'Seal / signature', 'enum', false, 'Whether a seal, stamp or signature is present or mentioned', { options: ['yes', 'no'] }),
    ],
  },
  {
    id: 'marksheet',
    label: 'Marksheet / report card',
    description: 'Statement of marks, grade card, transcript or school report card.',
    keywords: ['marksheet', 'mark sheet', 'marks obtained', 'statement of marks', 'grade card', 'report card', 'roll no', 'maximum marks', 'cgpa', 'sgpa', 'अंक', 'अनुक्रमांक'],
    entities: ['PERSON', 'ORG', 'ID', 'DATE'],
    fields: [
      f('student_name', 'Student name', 'string', true, 'Name of the student', { aliases: ['name of student', 'name of candidate', 'candidate name', 'name'] }),
      f('roll_number', 'Roll number', 'id', true, 'Roll / seat number', { aliases: ['roll no', 'seat no', 'roll number'] }),
      f('enrollment_number', 'Enrollment number', 'id', false, 'Enrollment / registration number', { aliases: ['enrollment no', 'enrolment no', 'registration no'] }),
      f('father_or_guardian_name', "Father's / guardian's name", 'string', false, "Father's or guardian's name", { aliases: ["father's name", 'guardian name'] }),
      f('mother_name', "Mother's name", 'string', false, "Mother's name"),
      f('date_of_birth', 'Date of birth', 'date', false, 'Date of birth', { aliases: ['dob', 'date of birth'] }),
      f('institution_name', 'Institution', 'string', true, 'School / college name'),
      f('board_or_university', 'Board / university', 'string', false, 'Examining board or university'),
      f('examination', 'Examination', 'string', true, 'Examination name, e.g. "Senior Secondary Examination 2024"'),
      f('class_or_semester', 'Class / semester', 'string', false, 'Class, semester or year'),
      f('session', 'Session', 'string', false, 'Academic session, e.g. 2023-24'),
      f('total_marks_obtained', 'Total marks obtained', 'number', true, 'Grand total of marks obtained', { aliases: ['total marks', 'grand total', 'marks obtained'] }),
      f('total_max_marks', 'Maximum marks', 'number', false, 'Grand total of maximum marks', { aliases: ['maximum marks', 'max marks', 'out of'] }),
      f('percentage', 'Percentage', 'number', false, 'Overall percentage'),
      f('cgpa', 'CGPA / SGPA', 'number', false, 'Grade point average'),
      f('result', 'Result', 'enum', false, 'Overall result', { options: ['PASS', 'FAIL', 'COMPARTMENT', 'WITHHELD', 'OTHER'] }),
      f('division', 'Division / grade', 'string', false, 'Division or overall grade'),
      f('issue_date', 'Issue date', 'date', false, 'Date of issue / declaration of result'),
    ],
  },
  {
    id: 'application_form',
    label: 'Application / form',
    description: 'Filled application, admission, registration, KYC or request form.',
    keywords: ['application form', 'applicant', 'registration form', 'admission form', 'declaration', 'signature of applicant', 'form no', 'आवेदन'],
    entities: ['PERSON', 'DATE', 'EMAIL', 'PHONE', 'LOCATION', 'ID'],
    fields: [
      f('form_title', 'Form title', 'string', true, 'Title of the form'),
      f('application_number', 'Application number', 'id', false, 'Application / form / reference number', { aliases: ['application no', 'form no', 'ref no'] }),
      f('applicant_name', 'Applicant name', 'string', true, 'Name of the applicant', { aliases: ['name of applicant', 'full name', 'name'] }),
      f('date_of_birth', 'Date of birth', 'date', false, 'Date of birth', { aliases: ['dob', 'date of birth'] }),
      f('gender', 'Gender', 'enum', false, 'Gender', { options: ['MALE', 'FEMALE', 'OTHER'] }),
      f('father_or_guardian_name', "Father's / guardian's name", 'string', false, "Father's or guardian's name", { aliases: ["father's name", 'guardian name'] }),
      f('email', 'Email', 'email', false, 'Email address', { aliases: ['email', 'e-mail', 'email id'] }),
      f('phone', 'Phone', 'phone', false, 'Phone / mobile number', { aliases: ['mobile', 'phone', 'contact no', 'mobile no'] }),
      f('address', 'Address', 'string', false, 'Postal address'),
      f('pincode', 'PIN code', 'id', false, '6-digit Indian PIN code', { format: 'pincode', aliases: ['pin', 'pincode', 'pin code'] }),
      f('id_number', 'ID number', 'id', false, 'Any ID number given (Aadhaar must stay masked)', { aliases: ['aadhaar no', 'id no'] }),
      f('position_or_course', 'Applied for', 'string', false, 'Post, course or service applied for', { aliases: ['post applied for', 'course applied for'] }),
      f('application_date', 'Application date', 'date', true, 'Date the form was filled / signed', { aliases: ['date', 'dated'] }),
      f('signature_present', 'Signature', 'enum', false, 'Whether the applicant signature is present or mentioned', { options: ['yes', 'no'] }),
    ],
  },
  {
    id: 'report',
    label: 'Report',
    description: 'Inspection, audit, progress, lab, financial or project report.',
    keywords: ['report', 'findings', 'summary', 'conclusion', 'recommendation', 'observations', 'executive summary', 'रिपोर्ट', 'प्रतिवेदन'],
    entities: ['ORG', 'PERSON', 'DATE', 'AMOUNT', 'LOCATION'],
    fields: [
      f('title', 'Title', 'string', true, 'Report title'),
      f('report_number', 'Report number', 'id', false, 'Report / reference number', { aliases: ['report no', 'ref no'] }),
      f('organization', 'Organisation', 'string', false, 'Organisation the report is from or about'),
      f('author', 'Author / department', 'string', false, 'Author, team or department', { aliases: ['prepared by', 'submitted by'] }),
      f('report_date', 'Report date', 'date', true, 'Date of the report', { aliases: ['date', 'dated'] }),
      f('period_covered', 'Period covered', 'string', false, 'Period the report covers'),
      f('key_findings', 'Key findings', 'list', false, 'Main findings (short items)'),
      f('recommendations', 'Recommendations', 'list', false, 'Recommendations (short items)'),
      f('conclusion', 'Conclusion', 'string', false, 'One-line conclusion'),
    ],
  },
  {
    id: 'identity_document',
    label: 'Identity document',
    description: 'ID card, PAN card, student/employee ID, licence or similar identity proof.',
    keywords: ['aadhaar', 'aadhar', 'pan card', 'voter id', 'identity card', 'id card', 'permanent account number', 'income tax department', 'driving licence', 'employee id', 'student id', 'date of birth', 'पहचान', 'स्थायी लेखा संख्या'],
    entities: ['PERSON', 'ID', 'DATE', 'ORG', 'LOCATION'],
    fields: [
      f('document_name', 'Document', 'string', true, 'Kind of ID, e.g. "PAN card", "Student ID card"'),
      f('id_number', 'ID number', 'id', true, 'Identity number (Aadhaar must stay masked)', { aliases: ['id no', 'card no', 'number'] }),
      f('holder_name', 'Holder name', 'string', true, 'Name of the card holder', { aliases: ['name'] }),
      f('father_or_guardian_name', "Father's / guardian's name", 'string', false, "Father's or guardian's name", { aliases: ["father's name"] }),
      f('date_of_birth', 'Date of birth', 'date', false, 'Date of birth', { aliases: ['dob', 'date of birth'] }),
      f('gender', 'Gender', 'enum', false, 'Gender', { options: ['MALE', 'FEMALE', 'OTHER'] }),
      f('address', 'Address', 'string', false, 'Address on the card'),
      f('issuing_authority', 'Issuing authority', 'string', false, 'Authority / institution issuing the ID'),
      f('issue_date', 'Issue date', 'date', false, 'Date of issue'),
      f('expiry_date', 'Valid until', 'date', false, 'Expiry / valid-till date', { aliases: ['valid till', 'valid upto', 'expiry'] }),
    ],
  },
  {
    id: 'institutional_record',
    label: 'Letter / notice / record',
    description: 'Official letter, notice, circular, office order, memo or institutional record.',
    keywords: ['notice', 'circular', 'eligibility circular', 'scholarship', 'applicants must submit', 'office order', 'memorandum', 'letter', 'ref no', 'subject', 'to whom it may concern', 'सूचना', 'परिपत्र', 'आदेश', 'विषय'],
    entities: ['ORG', 'PERSON', 'DATE', 'ID', 'LOCATION'],
    fields: [
      f('title_or_subject', 'Subject / title', 'string', true, 'Subject line or title', { aliases: ['subject', 'sub', 're', 'विषय'] }),
      f('reference_number', 'Reference number', 'id', false, 'Reference / letter / circular number', { aliases: ['ref no', 'reference no', 'letter no', 'circular no', 'no'] }),
      f('issuing_institution', 'Issuing institution', 'string', true, 'Institution or office issuing it'),
      f('date', 'Date', 'date', false, 'Date if explicitly shown in the document; optional', { aliases: ['date', 'dated', 'दिनांक'] }),
      f('addressed_to', 'Addressed to', 'string', false, 'Recipient(s)', { aliases: ['to'] }),
      f('issued_by_name', 'Issued by', 'string', false, 'Name of the signing officer'),
      f('issued_by_designation', 'Designation', 'string', false, 'Designation of the signing officer'),
      f('effective_date', 'Effective date', 'date', false, 'Date from which it applies'),
      f('deadline_date', 'Deadline', 'date', false, 'Last date / deadline mentioned', { aliases: ['last date'] }),
      f('key_points', 'Key points', 'list', false, 'Main instructions or decisions (short items)'),
    ],
  },
  {
    id: 'other',
    label: 'Other document',
    description: 'Anything else: generic key-value extraction.',
    keywords: [],
    entities: ['PERSON', 'ORG', 'DATE', 'AMOUNT', 'ID', 'LOCATION', 'EMAIL', 'PHONE'],
    fields: [
      f('title', 'Title', 'string', false, 'Title or heading of the document'),
      f('date', 'Date', 'date', false, 'Main date of the document', { aliases: ['date', 'dated'] }),
      f('issuer', 'Issuer / author', 'string', false, 'Who issued or wrote it'),
      f('reference_number', 'Reference number', 'id', false, 'Any reference / document number', { aliases: ['ref no', 'reference no', 'no'] }),
    ],
  },
];

/**
 * Classification taxonomy: category → type → subtype. Subtype keywords are
 * used when the model gives no subtype (and by the rule-based fallback).
 */
const sub = (id, label, keywords) => ({ id, label, keywords });
export const TAXONOMY = {
  invoice: { category: 'Financial', subtypes: [
    sub('tax_invoice', 'Tax invoice', ['tax invoice', 'gstin', 'cgst', 'sgst', 'igst']),
    sub('receipt', 'Receipt', ['receipt', 'received with thanks', 'payment received']),
    sub('quotation', 'Quotation / proforma', ['quotation', 'proforma', 'estimate']),
    sub('credit_note', 'Credit / debit note', ['credit note', 'debit note']),
  ] },
  certificate: { category: 'Academic', subtypes: [
    sub('completion', 'Course completion', ['completion', 'successfully completed']),
    sub('participation', 'Participation', ['participation', 'participated']),
    sub('merit', 'Merit / award', ['merit', 'award', 'awarded', 'achievement', 'prize']),
    sub('character', 'Character / bonafide', ['character', 'bonafide', 'conduct']),
    sub('migration', 'Migration / transfer', ['migration', 'transfer certificate', 'leaving certificate']),
    sub('government', 'Caste / income / domicile', ['caste', 'income certificate', 'domicile', 'tehsildar']),
  ] },
  marksheet: { category: 'Academic', subtypes: [
    sub('board', 'Board marksheet', ['board of', 'secondary examination', 'senior secondary']),
    sub('university', 'University grade card', ['university', 'semester', 'sgpa', 'cgpa', 'grade card']),
    sub('school_report', 'School report card', ['report card', 'term', 'progress report']),
  ] },
  application_form: { category: 'Administrative', subtypes: [
    sub('admission', 'Admission', ['admission']),
    sub('job', 'Job application', ['post applied', 'employment', 'vacancy', 'recruitment']),
    sub('scholarship', 'Scholarship', ['scholarship']),
    sub('kyc', 'KYC / account opening', ['kyc', 'know your customer', 'account opening']),
    sub('general', 'Other request', []),
  ] },
  report: { category: 'Administrative', subtypes: [
    sub('inspection', 'Inspection', ['inspection', 'inspected']),
    sub('audit', 'Audit', ['audit']),
    sub('progress', 'Progress / annual', ['progress', 'annual report', 'quarterly']),
    sub('lab', 'Lab / test', ['laboratory', 'test report', 'specimen', 'reference range']),
    sub('financial', 'Financial', ['balance sheet', 'profit and loss', 'financial statement']),
  ] },
  identity_document: { category: 'Identity', subtypes: [
    sub('pan_card', 'PAN card', ['permanent account number', 'income tax department', 'स्थायी लेखा संख्या']),
    sub('aadhaar', 'Aadhaar', ['aadhaar', 'unique identification', 'आधार']),
    sub('student_id', 'Student ID card', ['student', 'enrollment', 'roll no', 'school', 'university']),
    sub('employee_id', 'Employee ID card', ['employee', 'emp id', 'staff']),
    sub('driving_licence', 'Driving licence', ['driving licence', 'driving license', 'dl no']),
    sub('voter_id', 'Voter ID', ['election commission', 'elector', 'voter']),
    sub('passport', 'Passport', ['passport', 'republic of india']),
  ] },
  institutional_record: { category: 'Administrative', subtypes: [
    sub('notice', 'Notice', ['notice', 'सूचना']),
    sub('circular', 'Circular', ['circular', 'परिपत्र']),
    sub('office_order', 'Office order', ['office order', 'आदेश']),
    sub('letter', 'Letter', ['dear', 'yours faithfully', 'yours sincerely', 'to whom it may concern']),
    sub('minutes', 'Minutes of meeting', ['minutes', 'meeting held']),
  ] },
  other: { category: 'General', subtypes: [] },
};
for (const t of DOCUMENT_TYPES) Object.assign(t, TAXONOMY[t.id]);
export const SUBTYPE_IDS = [...new Set(Object.values(TAXONOMY).flatMap(t => t.subtypes.map(s => s.id)))];

export const DOC_TYPE_IDS = DOCUMENT_TYPES.map(t => t.id);
export const ENTITY_TYPES = ['PERSON', 'ORG', 'DATE', 'AMOUNT', 'ID', 'LOCATION', 'EMAIL', 'PHONE', 'OTHER'];
export const FIELD_TYPES = ['string', 'date', 'amount', 'number', 'id', 'email', 'phone', 'enum', 'list'];

const byId = new Map(DOCUMENT_TYPES.map(t => [t.id, t]));
export const getDocType = id => byId.get(id) || byId.get('other');
