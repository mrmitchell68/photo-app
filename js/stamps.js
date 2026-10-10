export const EMOJI = ['😀','😂','😍','😎','🥳','😜','🤩','😇','❤️','💖','💯','✨','⭐','🔥','🎉','🎈','🎁','👑','🌸','🌻','🌈','☀️','🌙','⚡','🌴','🏖️','🌊','🍕','🍦','🎂','☕','🐶','🐱','🦋','👍','🙌','✌️','👋','💪','📸','🎵','⚽','🏀','🚀','🏆','💋','👀','🕶️'];

const svg = (inner, vb = '0 0 200 200') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="400" height="400">${inner}</svg>`;
export const SVG_STAMPS = [
  { id: 'heart', svg: svg('<path d="M100 178S18 128 18 70a42 42 0 0 1 82-14 42 42 0 0 1 82 14c0 58-82 108-82 108z" fill="#ff3b6b" stroke="#fff" stroke-width="8"/>') },
  { id: 'star', svg: svg('<path d="M100 12l26 58 63 6-48 42 14 62-55-33-55 33 14-62-48-42 63-6z" fill="#ffd23f" stroke="#fff" stroke-width="8" stroke-linejoin="round"/>') },
  { id: 'bubble', svg: svg('<path d="M20 30h160a14 14 0 0 1 14 14v84a14 14 0 0 1-14 14H80l-40 36 6-36H20a14 14 0 0 1-14-14V44a14 14 0 0 1 14-14z" fill="#fff" stroke="#111" stroke-width="6"/>') },
  { id: 'wow', svg: svg('<path d="M100 6l18 34 36-14-4 38 38 10-28 26 24 30-38 4 2 38-34-18-14 36-16-36-34 16 4-38-38-6 26-28-26-28 38-6-6-38 36 14z" fill="#ffde00" stroke="#e8361c" stroke-width="6"/><text x="100" y="118" font-family="Impact,Arial Black,sans-serif" font-size="56" text-anchor="middle" fill="#e8361c">WOW!</text>') },
  { id: 'love', svg: svg('<rect x="10" y="60" width="180" height="80" rx="40" fill="#ff4f8b"/><text x="100" y="118" font-family="Arial Black,Impact,sans-serif" font-size="46" text-anchor="middle" fill="#fff">LOVE</text>') },
  { id: 'arrow', svg: svg('<path d="M20 88h110V50l60 50-60 50v-38H20z" fill="#00d1ff" stroke="#fff" stroke-width="8" stroke-linejoin="round"/>') },
  { id: 'crown', svg: svg('<path d="M20 150 30 60l45 40 25-60 25 60 45-40 10 90z" fill="#ffc83d" stroke="#b07800" stroke-width="6" stroke-linejoin="round"/><rect x="20" y="150" width="160" height="22" rx="6" fill="#ffb000" stroke="#b07800" stroke-width="6"/>') },
  { id: 'shades', svg: svg('<path d="M10 70h180v14h-8c-4 40-24 52-50 52-24 0-36-18-40-40h-8c-4 22-16 40-40 40-26 0-46-12-50-52H10z" fill="#111"/><path d="M36 92c4 22 14 30 28 30" stroke="#666" stroke-width="5" fill="none"/>', '0 0 200 200') },
  { id: 'sparkles', svg: svg('<path d="M80 20l14 46 46 14-46 14-14 46-14-46-46-14 46-14z" fill="#fff6a8"/><path d="M150 100l8 24 24 8-24 8-8 24-8-24-24-8 24-8z" fill="#fff"/><path d="M150 20l5 15 15 5-15 5-5 15-5-15-15-5 15-5z" fill="#fff"/>') },
  { id: 'sun', svg: svg('<circle cx="100" cy="100" r="44" fill="#ffcf33"/><g stroke="#ffcf33" stroke-width="12" stroke-linecap="round"><path d="M100 12v26M100 162v26M12 100h26M162 100h26M38 38l18 18M144 144l18 18M38 162l18-18M144 56l18-18"/></g>') },
  { id: 'hbd', svg: svg('<rect x="6" y="56" width="188" height="88" rx="16" fill="#7b5cff"/><text x="100" y="96" font-family="Arial Black,sans-serif" font-size="30" text-anchor="middle" fill="#fff">HAPPY</text><text x="100" y="130" font-family="Arial Black,sans-serif" font-size="30" text-anchor="middle" fill="#ffd23f">BIRTHDAY</text>') },
  { id: 'frame', svg: svg('<rect x="8" y="8" width="184" height="184" rx="10" fill="none" stroke="#fff" stroke-width="10"/><rect x="22" y="22" width="156" height="156" rx="6" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="8 6"/>') },
];
export const svgUrl = (s) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);

export function emojiDataURL(ch, size = 320) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `${Math.round(size * 0.82)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif`;
  g.fillText(ch, size / 2, size / 2 + size * 0.04);
  return c.toDataURL('image/png');
}

export const FONTS = [
  { name: 'Bebas Neue', css: '"Bebas Neue",Impact,sans-serif' },
  { name: 'Roboto', css: 'Roboto,system-ui,sans-serif', weight: 900 },
  { name: 'Pacifico', css: 'Pacifico,cursive' },
  { name: 'Permanent Marker', css: '"Permanent Marker",cursive' },
  { name: 'Lobster', css: 'Lobster,cursive' },
  { name: 'Playfair Display', css: '"Playfair Display",Georgia,serif', weight: 700 },
  { name: 'Impact', css: 'Impact,"Arial Black",sans-serif' },
  { name: 'Georgia', css: 'Georgia,serif' },
  { name: 'Courier New', css: '"Courier New",monospace' },
];
export const COLORS = ['#ffffff', '#000000', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#5856d6', '#ff2d55', '#a2845e', '#8e8e93'];
export const GRADIENTS = [
  { name: 'Sky', c1: '#4facfe', c2: '#00f2fe', angle: 180 },
  { name: 'Beach', c1: '#6ec6ff', c2: '#f5d9a6', angle: 180 },
  { name: 'Sunset', c1: '#ff7e5f', c2: '#feb47b', angle: 180 },
  { name: 'Purple', c1: '#7b5cff', c2: '#ff6ec4', angle: 135 },
  { name: 'Mint', c1: '#43e97b', c2: '#38f9d7', angle: 135 },
  { name: 'Peach', c1: '#ffecd2', c2: '#fcb69f', angle: 180 },
  { name: 'Night', c1: '#0f2027', c2: '#2c5364', angle: 180 },
  { name: 'Studio', c1: '#e0e0e0', c2: '#9e9e9e', angle: 180 },
];
