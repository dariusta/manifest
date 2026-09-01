import { createSignal, type Component } from 'solid-js';

/**
 * Copy text in both secure and self-hosted HTTP contexts.
 *
 * The async Clipboard API is unavailable on non-localhost HTTP origins. Manifest
 * can be self-hosted on one of those origins, so keep the user-gesture-based
 * execCommand path as a compatibility fallback.
 */
function copyTextFallback(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  textarea.style.opacity = '0';

  const activeElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const selectedRange = selection?.rangeCount ? selection.getRangeAt(0) : null;

  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();

    if (selection && selectedRange) {
      selection.removeAllRanges();
      selection.addRange(selectedRange);
    }
    activeElement?.focus({ preventScroll: true });
  }

  if (!copied) throw new Error('Clipboard API is unavailable');
}

const CopyButton: Component<{ text: string; disabled?: boolean }> = (props) => {
  const [copied, setCopied] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  const handleCopy = async () => {
    if (props.disabled) return;
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(props.text);
        } catch {
          // Permission policies can reject the modern API even when it exists.
          copyTextFallback(props.text);
        }
      } else {
        copyTextFallback(props.text);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 2000);
    }
  };

  return (
    <button
      class="modal-terminal__copy"
      classList={{ 'modal-terminal__copy--disabled': !!props.disabled }}
      onClick={handleCopy}
      disabled={props.disabled}
      title={
        props.disabled
          ? 'Reveal key first'
          : copied()
            ? 'Copied'
            : failed()
              ? 'Copy failed'
              : 'Copy'
      }
      aria-label={
        props.disabled
          ? 'Copy disabled'
          : copied()
            ? 'Copied'
            : failed()
              ? 'Copy failed'
              : 'Copy to clipboard'
      }
    >
      {copied() ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
    </button>
  );
};

export default CopyButton;
