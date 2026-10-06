// Dvir Clicker: cosmetic skins (window.DCSkins).
//
// FRAMES restyle the clicker circle. They are pure CSS (css/skins.css): applyFrame()
// only swaps the "frame-ID" class on the .clicker / .skin-preview element.
//
// ACCESSORIES are cartoon SVGs drawn on Dvir's head. Every SVG uses viewBox
// "0 0 100 100", which is exactly the dvir.webp square (the photo fills the circle's
// bounding box), so the coordinates below are measured on the photo itself:
//   eyes (iris centres)  left 46.4,38.9  right 61.9,38.5  (face tilted about -1.3deg)
//   eyebrows             y 34-36;  nose tip 54.5,47;  left ear 28.5-33 x 40.5-49
//   face edge at eyes    x 34.5 .. 69;  hair (with outline) x 23 .. 77 at y 26
//   top of hair          y 3-5 (left side lower), sticker outline peaks at y 1
// The SVGs may draw outside the box (overflow visible), e.g. a crown above the circle.
//
// Gradient / clip ids must be unique per page, and the same accessory can be shown
// several times at once (big clicker + menu thumbnails). Templates therefore use the
// token __ID__, replaced by a fresh "dcs-<accessory>-<n>" on every render.
(() => {
  "use strict";

  const INK = "#1a1030"; // dark outline, matches the photo's black sticker outline

  // ---------------------------------------------------------------
  // Small path helpers
  // ---------------------------------------------------------------
  const r1 = (v) => Math.round(v * 100) / 100;

  // Mirror an absolute M/L/Q/C/Z path horizontally around x = 0.
  function mirrorX(d) {
    let i = 0;
    return d.replace(/-?\d*\.?\d+/g, (n) => (i++ % 2 === 0 ? String(r1(-parseFloat(n))) : n));
  }

  // Closed "cloud" outline: n round bumps around a circle (pom-pom fluff).
  function fluff(cx, cy, r, n, bump) {
    let d = "";
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = r1(cx + r * Math.cos(a));
      const y = r1(cy + r * Math.sin(a));
      if (i === 0) {
        d += `M${x} ${y}`;
      } else {
        const m = a - Math.PI / n; // control point pushed outward between two bumps
        d += `Q${r1(cx + (r + bump * 2) * Math.cos(m))} ${r1(cy + (r + bump * 2) * Math.sin(m))} ${x} ${y}`;
      }
    }
    return d + "Z";
  }

  // Point on a quadratic bezier.
  function quad(p0, p1, p2, t) {
    const u = 1 - t;
    return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
  }

  // Scalloped band hanging under a quadratic curve (party hat trim).
  function scallopBand(p0, p1, p2, n, depth) {
    let d = `M${r1(p0[0])} ${r1(p0[1] - 1.2)}Q${r1(p1[0])} ${r1(p1[1] - 1.2)} ${r1(p2[0])} ${r1(p2[1] - 1.2)}`;
    for (let i = n; i > 0; i--) {
      const a = quad(p0, p1, p2, i / n);
      const b = quad(p0, p1, p2, (i - 1) / n);
      const m = quad(p0, p1, p2, (i - 0.5) / n);
      d += `L${r1(a[0])} ${r1(a[1] + 0.6)}Q${r1(m[0])} ${r1(m[1] + depth * 2)} ${r1(b[0])} ${r1(b[1] + 0.6)}`;
    }
    return d + "Z";
  }

  // 4-point sparkle star centred on (x, y).
  function sparkle(x, y, r) {
    const k = r * 0.22;
    return (
      `M${r1(x)} ${r1(y - r)}Q${r1(x + k)} ${r1(y - k)} ${r1(x + r)} ${r1(y)}` +
      `Q${r1(x + k)} ${r1(y + k)} ${r1(x)} ${r1(y + r)}Q${r1(x - k)} ${r1(y + k)} ${r1(x - r)} ${r1(y)}` +
      `Q${r1(x - k)} ${r1(y - k)} ${r1(x)} ${r1(y - r)}Z`
    );
  }

  function svgWrap(id, body) {
    return (
      `<svg class="dcs-acc dcs-acc-${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" ` +
      `overflow="visible" aria-hidden="true" focusable="false">` +
      `<g stroke="${INK}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${body}</g></svg>`
    );
  }

  // ---------------------------------------------------------------
  // Accessory artwork
  // ---------------------------------------------------------------

  // Sunglasses: wayfarer lenses centred on his irises, rotated with the face.
  function shadesSvg() {
    const lensR = "M-6 -4.4L6.4 -4.9Q7.6 -5 7.3 -3.4C7 1.4 5.4 5 1.2 5C-3.3 5 -5.8 3.3 -6.4 -1Q-6.7 -4.4 -6 -4.4Z";
    const lensL = mirrorX(lensR);
    const lens = (d, dx, clip) => `
      <path d="${d}" transform="translate(${dx} 0)" fill="url(#__ID__-lens)" stroke-width="2.3"/>
      <g clip-path="url(#__ID__-${clip})" stroke="none">
        <path d="M${dx - 2.6} -6L${dx + 1} -6L${dx - 4} 6L${dx - 7.6} 6Z" fill="#fff" opacity=".26"/>
        <path d="M${dx + 2.4} -6L${dx + 3.8} -6L${dx - 1.2} 6L${dx - 2.6} 6Z" fill="#fff" opacity=".18"/>
        <path d="${d}" transform="translate(${dx} 3.4)" fill="none" stroke="#ff6fae" stroke-width="2.2" opacity=".55"/>
      </g>`;
    return svgWrap(
      "shades",
      `<defs>
        <radialGradient id="__ID__-sh">
          <stop offset="0" stop-color="#1a1030" stop-opacity=".55"/><stop offset="1" stop-color="#1a1030" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="__ID__-lens" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#3b2a7e"/><stop offset=".5" stop-color="#140c33"/><stop offset="1" stop-color="#0a0620"/>
        </linearGradient>
        <clipPath id="__ID__-cr"><path d="${lensR}" transform="translate(7.75 0)"/></clipPath>
        <clipPath id="__ID__-cl"><path d="${lensL}" transform="translate(-7.75 0)"/></clipPath>
      </defs>
      <g transform="translate(54.15 38.7) rotate(-1.3)">
        <ellipse cx="-7.4" cy="4.6" rx="7.6" ry="3" fill="url(#__ID__-sh)" stroke="none" opacity=".7"/>
        <ellipse cx="8" cy="4.4" rx="7.6" ry="3" fill="url(#__ID__-sh)" stroke="none" opacity=".7"/>
        <path d="M-14.8 -3.6L-20.2 -2.4M14.9 -3.8L16.7 -3.4" stroke-width="2.4" fill="none"/>
        <path d="M-1.9 -3.9Q0 -5.8 1.9 -3.9" stroke-width="2.1" fill="none"/>
        ${lens(lensR, 7.75, "cr")}
        ${lens(lensL, -7.75, "cl")}
        <path d="M11.3 -3.1Q13.4 -3.4 14 -2.2M-4.3 -3.1Q-2.2 -3.4 -1.6 -2.2" stroke="#fff" stroke-width=".8" fill="none" opacity=".8"/>
      </g>`
    );
  }

  // Party hat: striped cone sunk into the top of his hair, leaning with its slope.
  function partySvg() {
    const cone = "M-13.5 0L-1.1 -24Q0 -25.6 1.1 -24L13.5 0Q0 4.6 -13.5 0Z";
    const trim = scallopBand([-14.2, 0], [0, 4.8], [14.2, 0], 10, 1.15);
    const pom = fluff(0, -25.8, 3.6, 11, 0.6);
    return svgWrap(
      "party",
      `<defs>
        <radialGradient id="__ID__-sh">
          <stop offset="0" stop-color="#1a1030" stop-opacity=".55"/><stop offset="1" stop-color="#1a1030" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="__ID__-cone" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#ff9ccb"/><stop offset=".4" stop-color="#ff4f9a"/><stop offset="1" stop-color="#c2125f"/>
        </linearGradient>
        <linearGradient id="__ID__-stripe" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#fff2a0"/><stop offset=".45" stop-color="#ffd23f"/><stop offset="1" stop-color="#f29a00"/>
        </linearGradient>
        <radialGradient id="__ID__-pom" cx=".38" cy=".32" r=".75">
          <stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="#bff6ff"/><stop offset="1" stop-color="#26b8e6"/>
        </radialGradient>
        <clipPath id="__ID__-clip"><path d="${cone}"/></clipPath>
      </defs>
      <g transform="translate(51 9.8) rotate(-16) scale(1.1)">
        <ellipse cx="0.8" cy="2.6" rx="16" ry="4.4" fill="url(#__ID__-sh)" stroke="none"/>
        <path d="${cone}" fill="url(#__ID__-cone)"/>
        <g clip-path="url(#__ID__-clip)" stroke="none">
          <path d="M-16 -2.6Q0 -3.6 16 -12.4L16 -8.4Q0 0.4 -16 1.4Z" fill="url(#__ID__-stripe)"/>
          <path d="M-16 -12Q0 -12.6 16 -21.4L16 -17.6Q0 -8.8 -16 -8.2Z" fill="url(#__ID__-stripe)"/>
          <path d="M-16 -21Q0 -21.6 16 -30.4L16 -26.8Q0 -18 -16 -17.4Z" fill="url(#__ID__-stripe)"/>
          <circle cx="-4.4" cy="-5.6" r="1.35" fill="#3ae0ff"/><circle cx="5.2" cy="-10.6" r="1.2" fill="#3ae0ff"/>
          <circle cx="-2.4" cy="-14.8" r="1.05" fill="#3ae0ff"/><circle cx="2.6" cy="-20.2" r=".85" fill="#3ae0ff"/>
          <path d="M-10 -1.6L-1.8 -21.6" stroke="#fff" stroke-width="1.8" opacity=".42"/>
          <path d="M6.2 4L1.2 -25L4 -25L16 4Z" fill="#7a0b3c" opacity=".22"/>
        </g>
        <path d="${cone}" fill="none"/>
        <path d="${trim}" fill="#fff6d6"/>
        <path d="${pom}" fill="url(#__ID__-pom)"/>
        <circle cx="-1.3" cy="-27.1" r="1.05" fill="#fff" stroke="none" opacity=".9"/>
      </g>`
    );
  }

  // Headphones: band hugging the outline of his hair, cups over the ears.
  function headphonesSvg() {
    const band = "M23.6 37C17.6 24 23.4 6.5 37 1.8C46 -1.4 58 -1.8 66 1C78 5.6 83.2 22 76.4 37";
    const cushion = "M29.8 6C31.9 4.2 34.3 2.7 37 1.8C46 -1.4 58 -1.8 66 1C68.4 1.9 70.5 3.3 72.3 5.1"; // the top stretch of the band, padded
    const cup = `
      <rect x="21.6" y="31" width="3.4" height="5" rx="1" fill="#6d6488"/>
      <rect x="25.1" y="36.2" width="6.9" height="15.6" rx="3.2" fill="url(#__ID__-pad)"/>
      <rect x="17.4" y="34" width="10.6" height="20" rx="5" fill="url(#__ID__-shell)"/>
      <rect x="19.6" y="37.4" width="6.2" height="13.2" rx="3.1" fill="#b3104f" stroke="none" opacity=".55"/>
      <path d="M19.8 40Q20 36.4 23 35.8" stroke="#fff" stroke-width="1.1" fill="none" opacity=".75"/>`;
    return svgWrap(
      "headphones",
      `<defs>
        <radialGradient id="__ID__-sh">
          <stop offset="0" stop-color="#1a1030" stop-opacity=".55"/><stop offset="1" stop-color="#1a1030" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="__ID__-shell" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ff9cc2"/><stop offset=".45" stop-color="#ff3d7f"/><stop offset="1" stop-color="#a80f4c"/>
        </linearGradient>
        <linearGradient id="__ID__-band" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#4a3d75"/><stop offset=".5" stop-color="#352a58"/><stop offset="1" stop-color="#4a3d75"/>
        </linearGradient>
        <linearGradient id="__ID__-cush" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ff8ab4"/><stop offset="1" stop-color="#e01f68"/>
        </linearGradient>
        <linearGradient id="__ID__-pad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#2a1f45"/><stop offset="1" stop-color="#4c4070"/>
        </linearGradient>
      </defs>
      <path d="${band}" fill="none" stroke-width="5.8"/>
      <path d="${band}" fill="none" stroke="url(#__ID__-band)" stroke-width="3"/>
      <path d="${cushion}" fill="none" stroke-width="7.6"/>
      <path d="${cushion}" fill="none" stroke="url(#__ID__-cush)" stroke-width="4.6"/>
      <path d="M36.6 0.6C45.6 -2.4 56 -2.8 63.4 -1.2" fill="none" stroke="#fff" stroke-width="1.1" opacity=".65"/>
      <path d="M22.2 28.4C21.2 20 24.6 11.6 31 6.6" fill="none" stroke="#fff" stroke-width=".8" opacity=".3"/>
      <ellipse cx="31.6" cy="45" rx="4" ry="9.6" fill="url(#__ID__-sh)" stroke="none"/>
      <ellipse cx="68.4" cy="45" rx="4" ry="9.6" fill="url(#__ID__-sh)" stroke="none"/>
      ${cup}
      <g transform="matrix(-1 0 0 1 100 0)">${cup}</g>`
    );
  }

  // Backwards baseball cap: dome on the hair, snapback opening at the front,
  // visor peeking out behind his head.
  function capSvg() {
    return svgWrap(
      "cap",
      `<defs>
        <radialGradient id="__ID__-sh">
          <stop offset="0" stop-color="#1a1030" stop-opacity=".55"/><stop offset="1" stop-color="#1a1030" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="__ID__-dome" cx=".36" cy=".2" r=".95">
          <stop offset="0" stop-color="#ff7a7a"/><stop offset=".45" stop-color="#e5293f"/><stop offset="1" stop-color="#8f0f2a"/>
        </radialGradient>
        <linearGradient id="__ID__-brim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#4656a8"/><stop offset="1" stop-color="#1c2558"/>
        </linearGradient>
      </defs>
      <g transform="rotate(-6 50 13)">
        <ellipse cx="50.4" cy="25.4" rx="28" ry="4.6" fill="url(#__ID__-sh)" stroke="none"/>
        <path d="M71 13.4C76.6 10.8 84.4 10.2 88.6 12.2C90.6 13.2 90.4 15.6 88.2 16.8C83 19.4 76.4 20.6 71.6 21Z" fill="url(#__ID__-brim)"/>
        <path d="M88.2 16.8C83 19.4 76.4 20.6 71.6 21L71.8 22.8C77 22.4 83.8 21 88.8 18.4C90 17.8 90.6 16.8 90.5 15.6C89.9 16.2 89.2 16.4 88.2 16.8Z" fill="#141a3d" stroke-width="1.1"/>
        <path d="M76 12.6C80.4 11.4 84.8 11.4 87.4 12.6" fill="none" stroke="#fff" stroke-width="1" opacity=".45"/>
        <path d="M24.6 22C22.4 7.6 35.4 0 50 0C64.6 0 77.6 7.6 75.4 22Q50 27.4 24.6 22Z" fill="url(#__ID__-dome)"/>
        <path d="M50 0L50 17.2M50 0C42.4 3.2 37.6 11.8 37 23.6M50 0C57.6 3.2 62.4 11.8 63 23.6" fill="none" stroke="#7d0c24" stroke-width=".9"/>
        <path d="M43.4 24.6C43.4 19.6 46.2 17.2 50 17.2C53.8 17.2 56.6 19.6 56.6 24.6Q50 25.4 43.4 24.6Z" fill="#3b2a20"/>
        <path d="M43.5 21.4Q50 22.4 56.5 21.4L56.6 23.8Q50 24.8 43.4 23.8Z" fill="#24306b" stroke-width="1.2"/>
        <circle cx="46.4" cy="22.7" r=".6" fill="#fff" stroke="none"/><circle cx="50" cy="23.1" r=".6" fill="#fff" stroke="none"/>
        <circle cx="53.6" cy="22.7" r=".6" fill="#fff" stroke="none"/>
        <ellipse cx="50" cy="-0.3" rx="2.6" ry="1.4" fill="#24306b"/>
        <ellipse cx="38.4" cy="6.8" rx="6.4" ry="2.6" transform="rotate(-30 38.4 6.8)" fill="#fff" stroke="none" opacity=".16"/>
        <path d="M30.6 10.2C34.6 4.2 41.2 1.6 46.8 1.4" fill="none" stroke="#fff" stroke-width="1.7" opacity=".5"/>
      </g>`
    );
  }

  // Crown: gold, five points with pearls, nestled into the top of the hair.
  function crownSvg() {
    const body = "M-17 0L-18.8 -13.6L-11.6 -6.8L-8.4 -17.4L-3.6 -7.6L0 -20.4L3.6 -7.6L8.4 -17.4L11.6 -6.8L18.8 -13.6L17 0Q0 3.4 -17 0Z";
    const pearls = [[-18.8, -13.6], [-8.4, -17.4], [0, -20.4], [8.4, -17.4], [18.8, -13.6]]
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.75" fill="url(#__ID__-pearl)" stroke-width="1.2"/>`)
      .join("");
    return svgWrap(
      "crown",
      `<defs>
        <radialGradient id="__ID__-sh">
          <stop offset="0" stop-color="#1a1030" stop-opacity=".55"/><stop offset="1" stop-color="#1a1030" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="__ID__-gold" x1="0" y1="0" x2=".5" y2="1">
          <stop offset="0" stop-color="#fff6b0"/><stop offset=".35" stop-color="#ffd23f"/><stop offset=".72" stop-color="#f4a011"/><stop offset="1" stop-color="#b86200"/>
        </linearGradient>
        <linearGradient id="__ID__-band" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffe066"/><stop offset="1" stop-color="#d98300"/>
        </linearGradient>
        <radialGradient id="__ID__-pearl" cx=".35" cy=".3" r=".8">
          <stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#d6cbe8"/>
        </radialGradient>
        <radialGradient id="__ID__-ruby" cx=".35" cy=".3" r=".8">
          <stop offset="0" stop-color="#ff9db0"/><stop offset=".5" stop-color="#ff2d55"/><stop offset="1" stop-color="#9e0028"/>
        </radialGradient>
        <radialGradient id="__ID__-sapph" cx=".35" cy=".3" r=".8">
          <stop offset="0" stop-color="#b8f0ff"/><stop offset=".5" stop-color="#2fa8ff"/><stop offset="1" stop-color="#1640a8"/>
        </radialGradient>
      </defs>
      <g transform="translate(50.8 11.6) rotate(-6) scale(1.12)">
        <ellipse cx="0.4" cy="2.4" rx="20" ry="4.4" fill="url(#__ID__-sh)" stroke="none"/>
        <path d="M-16.6 -4Q0 -10.4 16.6 -4L16.6 -1.4Q0 -7.4 -16.6 -1.4Z" fill="#a35a00" stroke-width="1.3"/>
        <path d="${body}" fill="url(#__ID__-gold)" stroke-width="1.35"/>
        <path d="M-16 -2.2L-17.4 -11.4L-15.4 -9.4ZM-7.4 -9.6L-8 -14.8L-6.2 -10.6ZM0.8 -10.2L0.4 -17.6L2 -11Z" fill="#fff" stroke="none" opacity=".7"/>
        <path d="M-17.3 -4.8Q0 -1.6 17.3 -4.8L17 0Q0 3.4 -17 0Z" fill="url(#__ID__-band)" stroke-width="1.35"/>
        <path d="M-15.6 -2.6Q0 0 15.6 -2.6" fill="none" stroke="#fff" stroke-width=".7" opacity=".55"/>
        <ellipse cx="0" cy="-0.7" rx="2.6" ry="2.1" fill="url(#__ID__-ruby)" stroke-width="1.1"/>
        <path d="M-9.8 -3.4L-8.2 -1.6L-9.8 0.2L-11.4 -1.6Z" fill="url(#__ID__-sapph)" stroke-width="1"/>
        <path d="M9.8 -3.4L11.4 -1.6L9.8 0.2L8.2 -1.6Z" fill="url(#__ID__-sapph)" stroke-width="1"/>
        <path d="M0 -13.6L1.4 -11.2L0 -9.2L-1.4 -11.2Z" fill="url(#__ID__-ruby)" stroke-width=".9"/>
        ${pearls}
        <circle cx="-0.8" cy="-1.5" r=".6" fill="#fff" stroke="none"/>
      </g>`
    );
  }

  // Halo: glowing gold ring floating above his hair (bobs via .dcs-acc-halo in CSS).
  function haloSvg() {
    const ring = "M-19.6 0A19.6 6.4 0 1 0 19.6 0A19.6 6.4 0 1 0 -19.6 0ZM-14.2 0A14.2 3.1 0 1 1 14.2 0A14.2 3.1 0 1 1 -14.2 0Z";
    return svgWrap(
      "halo",
      `<defs>
        <radialGradient id="__ID__-glow" cx=".5" cy=".5" r=".5">
          <stop offset="0" stop-color="#fff3a8" stop-opacity=".75"/><stop offset=".55" stop-color="#ffd84a" stop-opacity=".28"/><stop offset="1" stop-color="#ffd84a" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="__ID__-ring" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffc93a"/><stop offset=".55" stop-color="#ffe680"/><stop offset="1" stop-color="#fffbe0"/>
        </linearGradient>
      </defs>
      <g transform="translate(51.5 -6.6) rotate(-5) scale(1.07)">
        <ellipse cx="0" cy="0" rx="28" ry="11.5" fill="url(#__ID__-glow)" stroke="none"/>
        <path d="${ring}" fill="url(#__ID__-ring)" fill-rule="evenodd" stroke-width="1.3"/>
        <path d="M-12 4Q0 6.9 12 4" fill="none" stroke="#fff" stroke-width="1.2" opacity=".95"/>
        <path d="M-16.4 -2.6Q-8 -5.2 2 -5.3" fill="none" stroke="#fff" stroke-width=".8" opacity=".6"/>
        <g class="dcs-twinkle" fill="#fff" stroke="none">
          <path d="${sparkle(-22.5, -4.5, 2.6)}"/><path d="${sparkle(21.5, 3.5, 2)}"/><path d="${sparkle(13, -9.5, 1.5)}"/>
        </g>
      </g>`
    );
  }

  // ---------------------------------------------------------------
  // Catalogue
  // ---------------------------------------------------------------
  const frames = [
    { id: "gold", name: "זהב", swatch: "radial-gradient(circle at 35% 30%, #ffe48a, #ffc42e 45%, #ff9a1f)" },
    { id: "diamond", name: "יהלום", swatch: "radial-gradient(circle at 35% 30%, #ffffff, #bdf1ff 45%, #3fa6dc)" },
    { id: "fire", name: "אש", swatch: "radial-gradient(circle at 50% 65%, #fff1a0, #ff8a1f 40%, #c4200f)" },
    { id: "neon", name: "ניאון", swatch: "radial-gradient(circle at 50% 40%, #ff8af7, #b02cd6 40%, #24094f)" },
    {
      id: "rainbow",
      name: "קשת",
      swatch: "conic-gradient(#ff5f6d, #ffb347, #ffe66d, #7cff6b, #3ae0ff, #6a8bff, #c77dff, #ff5f6d)",
    },
    {
      id: "galaxy",
      name: "גלקסיה",
      swatch:
        "radial-gradient(circle at 30% 30%, #fff 0 6%, transparent 9%), radial-gradient(circle at 68% 62%, #fff 0 4%, transparent 7%), radial-gradient(circle at 50% 45%, #5b3bd6, #1c0f4f 60%, #070418)",
    },
  ];
  const FRAME_IDS = frames.map((f) => f.id);

  const TEMPLATES = {
    none: "",
    party: partySvg(),
    shades: shadesSvg(),
    headphones: headphonesSvg(),
    cap: capSvg(),
    crown: crownSvg(),
    halo: haloSvg(),
  };

  let uid = 0;
  // Give one copy of a template its own ids so url(#...) never points at another copy.
  function instantiate(id) {
    const tpl = TEMPLATES[id];
    if (!tpl) return "";
    uid += 1;
    return tpl.replace(/__ID__/g, `dcs-${id}-${uid}`);
  }

  const ACC_META = [
    ["none", "בלי אביזר", "🚫"],
    ["party", "כובע מסיבה", "🥳"],
    ["shades", "משקפי שמש", "😎"],
    ["headphones", "אוזניות", "🎧"],
    ["cap", "כובע הפוך", "🧢"],
    ["crown", "כתר", "👑"],
    ["halo", "הילה", "😇"],
  ];
  // `svg` is a getter: every read returns a copy with fresh ids, so it is safe to
  // insert the same accessory several times. Prefer renderAccessory() for the DOM.
  const accessories = ACC_META.map(([id, name, icon]) => {
    const a = { id, name, icon };
    Object.defineProperty(a, "svg", { enumerable: true, get: () => instantiate(id) });
    return a;
  });

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------
  function applyFrame(el, id) {
    try {
      if (!el || !el.classList) return;
      const want = FRAME_IDS.indexOf(id) >= 0 ? id : "gold";
      const old = [];
      el.classList.forEach((c) => {
        if (c.indexOf("frame-") === 0) old.push(c);
      });
      old.forEach((c) => {
        if (c !== "frame-" + want) el.classList.remove(c);
      });
      el.classList.add("frame-" + want);
    } catch (e) {
      // cosmetic only: never break the game
    }
  }

  function renderAccessory(container, id) {
    try {
      if (!container) return;
      const key = Object.prototype.hasOwnProperty.call(TEMPLATES, id) ? id : "none";
      if (container.getAttribute("data-acc") === key && (key === "none") === !container.firstChild) return;
      container.innerHTML = instantiate(key);
      container.setAttribute("data-acc", key);
    } catch (e) {
      // cosmetic only: never break the game
    }
  }

  window.DCSkins = { frames, accessories, applyFrame, renderAccessory };
})();
