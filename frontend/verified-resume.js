const verifiedResumeState = { current: null, publicResult: null, busy: false, pendingTransactionHash: '' };
const verified$ = id => document.getElementById(id);
const verifiedEscape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

async function sha256Text(text) {
  const bytes = new TextEncoder().encode(text);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function verificationStatusLabel(status) {
  return ({
    integrity_match: 'Integrity verified',
    not_anchored: 'Not blockchain verified',
    ledger_unavailable: 'Blockchain check unavailable',
    ledger_record_missing: 'Ledger record missing',
    record_modified: 'Record modified',
    record_not_found: 'Record not found'
  })[status] || 'Integrity status unavailable';
}

function setVerificationStatus(message, kind = '') {
  const status = verified$('verificationStatus');
  status.textContent = message;
  status.className = `status ${kind}`;
}

function renderVerificationRecord(entry, result) {
  verifiedResumeState.current = entry;
  verifiedResumeState.publicResult = result;
  const isMatch = result?.status === 'integrity_match';
  verified$('verificationRecordSummary').innerHTML = `<div class="verification-summary-row"><span>Verification ID</span><code>${verifiedEscape(entry.verificationId)}</code></div><div class="verification-summary-row"><span>Record status</span><strong>${verifiedEscape(verificationStatusLabel(result?.status || 'not_anchored'))}</strong></div><div class="verification-summary-row"><span>Assessed skills</span><strong>${entry.record.skills.filter(skill => skill.status === 'verified').length} passed · ${entry.record.skills.filter(skill => skill.status === 'not_assessed').length} not assessed</strong></div>`;
  verified$('anchorVerificationBtn').disabled = verifiedResumeState.busy || isMatch || !entry.recordHash;
  verified$('downloadVerifiedPdfBtn').disabled = verifiedResumeState.busy || !entry.publicUrl || !entry.record;
  verified$('verificationQrWrap').classList.add('hide');
  if (entry.publicUrl && typeof window.qrcode === 'function') {
    verified$('verificationQr').replaceChildren();
    try {
      const code=window.qrcode(0,'M');code.addData(entry.publicUrl,'Byte');code.make();
      const image=document.createElement('img');image.alt='QR code for the public verification record';image.src=code.createDataURL(5,2);image.width=168;image.height=168;
      verified$('verificationQr').append(image);
      const link = verified$('verificationPublicLink');
      link.href = entry.publicUrl;
      link.textContent = entry.publicUrl;
      verified$('verificationQrWrap').classList.remove('hide');
    } catch { setVerificationStatus('Record loaded, but the QR code could not be generated.', 'error'); }
  }
  if (result?.status === 'integrity_match') {
    verifiedResumeState.pendingTransactionHash = '';
    setVerificationStatus('Record integrity verified on the configured ResumeRegistry. This confirms record integrity only, not identity or skill authenticity.', 'ok');
  }
  else if (result?.status === 'ledger_unavailable') setVerificationStatus('Record saved off-chain; the ledger could not be reached. No skills are labelled blockchain verified.', 'error');
  else if (result?.status === 'record_modified' || result?.status === 'ledger_record_missing') setVerificationStatus('Record integrity check failed. The PDF will not label any skill as verified.', 'error');
  else setVerificationStatus('Record created. Connect a wallet and anchor the record before any skill can be shown as integrity verified.');
}

async function loadVerificationRecords() {
  try {
    const response = await fetch('/api/verifications', { cache: 'no-store' });
    const data = await response.json();
    if (response.status === 401) return;
    if (!response.ok) throw Error(data.error || 'Could not load verification records.');
    if (!data.publicUrlConfigured) {
      setVerificationStatus('Configure PUBLIC_BASE_URL as the HTTPS address reachable from another device before creating a QR verification link.', 'error');
      return;
    }
    if (!data.records?.length) {
      if (!data.ledgerConfigured) setVerificationStatus('Configure EVM_RPC_URL and RESUME_REGISTRY_ADDRESS on the server to enable real blockchain validation.', 'error');
      return;
    }
    const entry = data.records[0];
    renderVerificationRecord(entry, await fetchPublicResult(entry.verificationId));
    if (!data.ledgerConfigured) setVerificationStatus('Record loaded, but EVM_RPC_URL and RESUME_REGISTRY_ADDRESS are not configured. Integrity cannot be verified against a ledger.', 'error');
  } catch (error) {
    setVerificationStatus(error.message, 'error');
  }
}

async function fetchPublicResult(verificationId) {
  const response = await fetch(`/api/public-verifications/${encodeURIComponent(verificationId)}`, { cache: 'no-store' });
  const data = await response.json();
  if (response.status === 404) return { ...data, status: 'record_not_found' };
  if (!response.ok) throw Error(data.message || data.error || 'Could not verify the public record.');
  return data;
}

async function createVerificationRecord() {
  if (verifiedResumeState.busy) return;
  verifiedResumeState.busy = true;
  verified$('createVerificationBtn').disabled = true;
  setVerificationStatus('Creating an immutable assessment snapshot…');
  try {
    const response = await fetch('/api/verifications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Could not create a verification record.');
    const listResponse = await fetch('/api/verifications', { cache: 'no-store' });
    const list = await listResponse.json();
    const entry = list.records?.find(item => item.verificationId === data.verificationId);
    if (!entry) throw Error('The saved verification record could not be reloaded.');
    const result = await fetchPublicResult(entry.verificationId);
    renderVerificationRecord(entry, result);
    if (result.status !== 'integrity_match') await anchorVerificationRecord();
  } catch (error) {
    setVerificationStatus(error.message || 'Could not create a verification record.', 'error');
  } finally {
    verifiedResumeState.busy = false;
    verified$('createVerificationBtn').disabled = false;
    if (verifiedResumeState.current) renderVerificationRecord(verifiedResumeState.current, verifiedResumeState.publicResult);
  }
}

async function anchorVerificationRecord() {
  const entry = verifiedResumeState.current;
  if (!entry) {
    setVerificationStatus('Create a verification record first.');
    return;
  }
  if (!window.ethereum || !window.ethers) {
    setVerificationStatus('Record saved, but blockchain anchoring needs an EVM wallet such as MetaMask and ethers.js.', 'error');
    return;
  }
  if (!conf.contractAddress || !ethers.isAddress(conf.contractAddress)) {
    setVerificationStatus('Record saved, but a deployed ResumeRegistry address is missing from Settings.', 'error');
    return;
  }
  verifiedResumeState.busy = true;
  verified$('anchorVerificationBtn').disabled = true;
  setVerificationStatus('Connect your wallet and approve the transaction. Only the record hash is sent to the contract.');
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    let transactionHash = verifiedResumeState.pendingTransactionHash;
    if (!transactionHash) {
      const registry = new ethers.Contract(conf.contractAddress, ['function registerResume(bytes32 resumeHash)'], signer);
      const transaction = await registry.registerResume(`0x${entry.recordHash}`);
      transactionHash = transaction.hash;
      verifiedResumeState.pendingTransactionHash = transactionHash;
      setVerificationStatus('Transaction submitted; waiting for wallet-network confirmation…');
      await transaction.wait();
    }
    const response = await fetch(`/api/verifications/${encodeURIComponent(entry.verificationId)}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactionHash })
    });
    const confirmation = await response.json();
    if (!response.ok) throw Error(confirmation.error || 'The server could not confirm the transaction on its configured ledger.');
    const publicResult = await fetchPublicResult(entry.verificationId);
    renderVerificationRecord(entry, publicResult);
    if (publicResult.status !== 'integrity_match') throw Error(publicResult.message || 'The ledger did not confirm a matching record.');
  } catch (error) {
    setVerificationStatus(`Record remains unverified: ${error.shortMessage || error.message || 'Blockchain operation failed.'}`, 'error');
    verifiedResumeState.publicResult = { status: 'ledger_unavailable' };
  } finally {
    verifiedResumeState.busy = false;
    if (verifiedResumeState.current) renderVerificationRecord(verifiedResumeState.current, verifiedResumeState.publicResult);
  }
}

function verifiedSkillLabel(skill, integrityValid) {
  if (skill.status === 'not_assessed') return 'Not Assessed';
  if (skill.status === 'verified' && integrityValid) return `Verified · ${skill.score}% assessment score`;
  if (skill.status === 'verified' && !integrityValid) return 'Assessment passed · record integrity not verified';
  return 'Not Verified · assessment criteria not met';
}

function resumeForPdf(text, includeContact) {
  if (includeContact) return text;
  let lines = String(text).split(/\r?\n/);
  if (typeof resumeSectionRules !== 'undefined') {
    const firstSection = lines.findIndex(line => resumeSectionRules.some(rule => rule.pattern.test(line.trim().replace(/:$/, ''))));
    if (firstSection > 0) lines = lines.slice(firstSection);
  }
  return lines.filter(line => !/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\+?\d[\d\s().-]{7,}\d|linkedin\.com|github\.com|\b(address|phone|mobile|email|contact details)\s*:/i.test(line)).join('\n');
}

async function downloadVerifiedPdf() {
  const entry = verifiedResumeState.current;
  if (!entry?.publicUrl || !window.jspdf?.jsPDF || typeof window.qrcode !== 'function') {
    setVerificationStatus('PDF export needs a public HTTPS verification URL plus the PDF and QR libraries.', 'error');
    return;
  }
  const fullResume = document.getElementById('resume').value;
  if (!fullResume.trim()) {
    setVerificationStatus('Upload or paste a resume before exporting.', 'error');
    return;
  }
  const currentResume = resumeForPdf(fullResume, verified$('includeContactInPdf').checked);
  verified$('downloadVerifiedPdfBtn').disabled = true;
  setVerificationStatus('Rechecking public ledger integrity before generating the PDF…');
  try {
    const result = await fetchPublicResult(entry.verificationId);
    renderVerificationRecord(entry, result);
    const sameResume = await sha256Text(fullResume) === entry.record.resumeSha256;
    const integrityValid = result.status === 'integrity_match' && sameResume;
    if (!sameResume) setVerificationStatus('The current resume text differs from the text snapshot. No skills will be marked verified; create a new record for this version.', 'error');
    const qr = window.qrcode(0, 'M');
    qr.addData(entry.publicUrl, 'Byte');
    qr.make();
    const qrData = qr.createDataURL(6, 2);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const left = 18;
    const right = pageWidth - 18;
    let y = 18;
    pdf.setFillColor(20, 45, 78);
    pdf.rect(0, 0, pageWidth, 36, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(18);
    pdf.text('Credixa Verified Skills', left, 16);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(153, 226, 216);
    pdf.text(integrityValid ? 'Record integrity verified · skill outcomes are assessment evidence' : 'Integrity not verified · no skill is presented as blockchain verified', left, 24);
    pdf.setFontSize(8);
    pdf.text(`Verification ID: ${entry.verificationId}`, left, 31);
    pdf.addImage(qrData, 'PNG', right - 29, 5, 25, 25);
    y = 45;
    pdf.setTextColor(20, 45, 78);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.text('Skill assessment status', left, y);
    y += 7;
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');
    for (const skill of entry.record.skills) {
      const label = verifiedSkillLabel(skill, integrityValid);
      pdf.setFont('helvetica', 'bold');
      pdf.text(skill.skill, left, y);
      pdf.setFont('helvetica', 'normal');
      pdf.text(label, left + 52, y, { maxWidth: right - left - 52 });
      y += 6;
      if (y > pageHeight - 22) { pdf.addPage(); y = 20; }
    }
    y += 5;
    pdf.setFontSize(8);
    pdf.setTextColor(82, 98, 122);
    pdf.text(`Assessment date: ${entry.record.assessmentDate ? new Date(entry.record.assessmentDate).toLocaleDateString() : 'No assessment completed'}`, left, y);
    y += 5;
    const verifyNote = pdf.splitTextToSize(`Public record: ${entry.publicUrl}`, right - left);
    pdf.text(verifyNote, left, y);
    y += verifyNote.length * 4 + 8;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.setTextColor(20, 45, 78);
    pdf.text('Resume', left, y);
    y += 7;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(20, 45, 78);
    const lines = pdf.splitTextToSize(currentResume, right - left);
    for (const line of lines) {
      if (y > pageHeight - 16) { pdf.addPage(); y = 18; }
      pdf.text(line, left, y);
      y += 4.5;
    }
    const pages = pdf.getNumberOfPages();
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      pdf.setPage(pageNumber);
      pdf.setFontSize(7);
      pdf.setTextColor(120, 130, 134);
      pdf.text('Assessment evidence is separate from identity; hash matching confirms record integrity only.', left, pageHeight - 8);
      pdf.text(`${pageNumber}/${pages}`, right, pageHeight - 8, { align: 'right' });
    }
    pdf.save('credixa-verified-skills-resume.pdf');
    if (!integrityValid) setVerificationStatus('PDF downloaded with unverified/not-assessed labels because the current record or resume text did not pass integrity validation.', 'error');
  } catch (error) {
    setVerificationStatus(`PDF export failed: ${error.message || 'Could not generate the PDF.'}`, 'error');
  } finally {
    verified$('downloadVerifiedPdfBtn').disabled = false;
  }
}

verified$('createVerificationBtn').addEventListener('click', createVerificationRecord);
verified$('anchorVerificationBtn').addEventListener('click', anchorVerificationRecord);
verified$('downloadVerifiedPdfBtn').addEventListener('click', downloadVerifiedPdf);
document.addEventListener('DOMContentLoaded', loadVerificationRecords);
document.addEventListener('credixa:authenticated', loadVerificationRecords);
