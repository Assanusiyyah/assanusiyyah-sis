// ── Shared document export helpers ──────────────────────────
// Used across the app to turn an already-built printable HTML string (the
// pattern most "printX" functions in App.jsx already use) into a real
// downloadable PDF, a shareable file, or a genuine .xlsx spreadsheet —
// without having to re-implement each document's layout a second time.
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import html2canvas from "html2canvas";
import * as XLSX from "xlsx";

// Opens the given HTML in a new window and triggers the browser's print
// dialog — this is the same behaviour every printX() function already had.
export function printHtmlDoc(html){
  const w = window.open("", "_blank");
  if(!w) return;
  w.document.write(html);
  w.document.close();
  w.print();
}

// Renders an HTML string off-screen in a hidden iframe and resolves once
// its images have finished loading, so html2canvas captures the real
// content instead of blank/broken image boxes.
function renderHtmlOffscreen(html){
  return new Promise(function(resolve){
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-10000px";
    iframe.style.top = "0";
    iframe.style.width = "800px";
    iframe.style.height = "1px";
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    doc.open(); doc.write(html); doc.close();
    const finish = function(){
      const body = doc.body;
      iframe.style.height = body.scrollHeight + "px";
      resolve({ iframe, body });
    };
    const images = Array.prototype.slice.call(doc.images || []);
    if(images.length === 0) return setTimeout(finish, 50);
    let remaining = images.length;
    images.forEach(function(img){
      if(img.complete) { if(--remaining <= 0) finish(); return; }
      img.addEventListener("load", function(){ if(--remaining <= 0) finish(); });
      img.addEventListener("error", function(){ if(--remaining <= 0) finish(); });
    });
  });
}

async function htmlToCanvas(html){
  const { iframe, body } = await renderHtmlOffscreen(html);
  try{
    return await html2canvas(body, { scale:2, useCORS:true, backgroundColor:"#ffffff" });
  } finally {
    document.body.removeChild(iframe);
  }
}

// Downloads an already-built HTML document (receipt, report card, ID card,
// admission letter, etc.) as a real .pdf file, preserving its visual layout.
export async function downloadHtmlDocAsPDF(html, filename){
  const canvas = await htmlToCanvas(html);
  const orientation = canvas.width > canvas.height ? "landscape" : "portrait";
  const doc = new jsPDF({ orientation, unit:"pt", format:"a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const ratio = Math.min(pageW/canvas.width, pageH/canvas.height);
  const w = canvas.width*ratio, h = canvas.height*ratio;
  const imgData = canvas.toDataURL("image/png");
  doc.addImage(imgData, "PNG", (pageW-w)/2, 0, w, h);
  doc.save((filename||"document")+".pdf");
}

// Shares an already-built HTML document as a PDF file via the Web Share
// API (native share sheet on phones/tablets); falls back to a plain
// download when sharing files isn't supported (most desktop browsers).
export async function shareHtmlDoc(html, filename, title){
  const canvas = await htmlToCanvas(html);
  const orientation = canvas.width > canvas.height ? "landscape" : "portrait";
  const doc = new jsPDF({ orientation, unit:"pt", format:"a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const ratio = Math.min(pageW/canvas.width, pageH/canvas.height);
  const w = canvas.width*ratio, h = canvas.height*ratio;
  const imgData = canvas.toDataURL("image/png");
  doc.addImage(imgData, "PNG", (pageW-w)/2, 0, w, h);
  const blob = doc.output("blob");
  const fname = (filename||"document")+".pdf";
  const file = new File([blob], fname, { type:"application/pdf" });
  if(navigator.share && navigator.canShare && navigator.canShare({ files:[file] })){
    try{ await navigator.share({ files:[file], title: title||fname }); return; }
    catch(e){ /* user cancelled the share sheet — fall through to download */ }
  }
  doc.save(fname);
}

// Same as downloadHtmlDocAsPDF/shareHtmlDoc, but captures an already-mounted
// DOM node directly (for views built as React JSX rather than a raw HTML
// string, e.g. a modal that currently relies on window.print()).
export async function downloadNodeAsPDF(node, filename){
  if(!node) return;
  const canvas = await html2canvas(node, { scale:2, useCORS:true, backgroundColor:"#ffffff" });
  const orientation = canvas.width > canvas.height ? "landscape" : "portrait";
  const doc = new jsPDF({ orientation, unit:"pt", format:"a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const ratio = Math.min(pageW/canvas.width, pageH/canvas.height);
  const w = canvas.width*ratio, h = canvas.height*ratio;
  const imgData = canvas.toDataURL("image/png");
  doc.addImage(imgData, "PNG", (pageW-w)/2, 0, w, h);
  doc.save((filename||"document")+".pdf");
}

export async function shareNode(node, filename, title){
  if(!node) return;
  const canvas = await html2canvas(node, { scale:2, useCORS:true, backgroundColor:"#ffffff" });
  const orientation = canvas.width > canvas.height ? "landscape" : "portrait";
  const doc = new jsPDF({ orientation, unit:"pt", format:"a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const ratio = Math.min(pageW/canvas.width, pageH/canvas.height);
  const w = canvas.width*ratio, h = canvas.height*ratio;
  const imgData = canvas.toDataURL("image/png");
  doc.addImage(imgData, "PNG", (pageW-w)/2, 0, w, h);
  const blob = doc.output("blob");
  const fname = (filename||"document")+".pdf";
  const file = new File([blob], fname, { type:"application/pdf" });
  if(navigator.share && navigator.canShare && navigator.canShare({ files:[file] })){
    try{ await navigator.share({ files:[file], title: title||fname }); return; }
    catch(e){ /* user cancelled — fall through to download */ }
  }
  doc.save(fname);
}

// Exports an array-of-objects table (Students list, Broadsheet, Attendance,
// Financial statement, etc.) as a genuine .xlsx spreadsheet.
export function exportTableToExcel({ sheetName, columns, rows, filename }){
  const aoa = [columns].concat(rows);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, (sheetName||"Sheet1").slice(0,31));
  XLSX.writeFile(wb, (filename||sheetName||"export")+".xlsx");
}

// Exports the same table as a PDF using a real table layout (crisper and
// smaller than a screenshot-based PDF — best for large tabular reports).
export function exportTableToPDF({ title, subtitle, columns, rows, filename, orientation }){
  const doc = new jsPDF({ orientation: orientation||"landscape", unit:"pt" });
  let y = 36;
  if(title){ doc.setFontSize(14); doc.setFont(undefined,"bold"); doc.text(title, 32, y); y += 16; }
  if(subtitle){ doc.setFontSize(9); doc.setFont(undefined,"normal"); doc.setTextColor(100); doc.text(subtitle, 32, y); doc.setTextColor(0); y += 10; }
  autoTable(doc, {
    startY: y+8,
    head: [columns],
    body: rows,
    styles: { fontSize:8, cellPadding:4 },
    headStyles: { fillColor:[35,14,106], textColor:[240,192,96] },
    margin: { left:32, right:32 }
  });
  doc.save((filename||title||"export")+".pdf");
}

// Shares a table export (as PDF) via the Web Share API, falling back to download.
export async function shareTableAsPDF({ title, subtitle, columns, rows, filename, orientation }){
  const doc = new jsPDF({ orientation: orientation||"landscape", unit:"pt" });
  let y = 36;
  if(title){ doc.setFontSize(14); doc.setFont(undefined,"bold"); doc.text(title, 32, y); y += 16; }
  if(subtitle){ doc.setFontSize(9); doc.setFont(undefined,"normal"); doc.setTextColor(100); doc.text(subtitle, 32, y); doc.setTextColor(0); y += 10; }
  autoTable(doc, {
    startY: y+8,
    head: [columns],
    body: rows,
    styles: { fontSize:8, cellPadding:4 },
    headStyles: { fillColor:[35,14,106], textColor:[240,192,96] },
    margin: { left:32, right:32 }
  });
  const blob = doc.output("blob");
  const fname = (filename||title||"export")+".pdf";
  const file = new File([blob], fname, { type:"application/pdf" });
  if(navigator.share && navigator.canShare && navigator.canShare({ files:[file] })){
    try{ await navigator.share({ files:[file], title: title||fname }); return; }
    catch(e){ /* user cancelled — fall through to download */ }
  }
  doc.save(fname);
}
