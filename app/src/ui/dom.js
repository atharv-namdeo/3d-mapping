/** Tiny DOM helpers. Text always goes through textContent, so POI names can never inject markup. */
export const $ = (selector, root = document) => root.querySelector(selector);

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'style') node.style.cssText = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

export function formatDistance(metres) {
  if (!Number.isFinite(metres)) return 'no route';
  if (metres < 10) return `${metres.toFixed(1)} m`;
  return `${Math.round(metres)} m`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  return `${Math.round(seconds / 60)} min`;
}

export function toast(message, kind = 'info', ms = 3200) {
  const node = el('div', { class: `toast toast--${kind}`, text: message });
  $('#toasts').appendChild(node);
  setTimeout(() => { node.classList.add('is-leaving'); setTimeout(() => node.remove(), 300); }, ms);
}
