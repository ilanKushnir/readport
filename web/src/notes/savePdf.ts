/**
 * Handing a finished PDF to the reader.
 *
 * On a phone or a tablet the share sheet is where a file goes - Save to
 * Files, Books, Mail, AirDrop - so a touch screen that can share files gets
 * it. Everywhere else, and wherever sharing is refused, it is a download
 * named after the book. Called straight from the tap: a share sheet will
 * only open inside the gesture that asked for it, which is why the PDF is
 * made before the button is shown rather than when it is pressed.
 */
export async function savePdf(
  pdf: Blob,
  fileName: string,
  title: string,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([pdf], fileName, { type: 'application/pdf' });
  const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return 'cancelled';
      // Refused for another reason (no permission, a sheet already open):
      // the download still works.
    }
  }
  const url = URL.createObjectURL(pdf);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // Long enough for any browser to have started the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}

/** The PDF as the server sent it (base64), as a file-shaped thing. */
export function pdfFromBase64(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'application/pdf' });
}
