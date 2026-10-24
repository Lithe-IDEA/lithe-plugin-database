// Copying through a copy event, which WebKit allows during a user action
// without the asynchronous clipboard API a custom-scheme page may lack.
export function copyToClipboard(text: string): void {
  const onCopy = (event: ClipboardEvent) => {
    event.preventDefault();
    event.clipboardData?.setData('text/plain', text);
  };
  document.addEventListener('copy', onCopy, { once: true });
  const copied = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  if (!copied) void navigator.clipboard?.writeText(text).catch(() => {});
}
