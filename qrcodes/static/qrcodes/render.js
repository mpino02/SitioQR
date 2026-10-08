/* Renderizado de QR: SVG con diseño + marco, y exportación a PNG/JPG/WEBP/SVG/PDF */
(function () {
  const DEFAULT_DESIGN = {
    dotType: 'rounded', dotColor: '#09477e', gradOn: false, dotColor2: '#1369ae', gradType: 'linear',
    cornerSq: 'extra-rounded', cornerSqColor: '#09477e', cornerDot: 'dot', cornerDotColor: '#09477e',
    bgColor: '#ffffff', bgTransparent: false, margin: 20, ecl: 'M',
    logo: null, logoSize: 0.3, logoMargin: 6, logoHideDots: true,
    frameOn: false, frameText: 'ESCANÉAME', frameColor: '#09477e', frameTextColor: '#ffffff', frameFont: 56, frameRadius: 40,
  };

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function buildSvg(data, design) {
    const d = Object.assign({}, DEFAULT_DESIGN, design || {});
    const S = 1000;
    const ecl = d.logo && (d.ecl === 'L' || d.ecl === 'M') ? 'Q' : d.ecl;
    const dots = { type: d.dotType, color: d.dotColor };
    if (d.gradOn) {
      dots.gradient = { type: d.gradType, rotation: Math.PI / 4,
        colorStops: [{ offset: 0, color: d.dotColor }, { offset: 1, color: d.dotColor2 }] };
    }
    const qr = new QRCodeStyling({
      type: 'svg', width: S, height: S, data: data || ' ', margin: Number(d.margin) || 0,
      qrOptions: { errorCorrectionLevel: ecl },
      dotsOptions: dots,
      cornersSquareOptions: { type: d.cornerSq, color: d.cornerSqColor },
      cornersDotOptions: { type: d.cornerDot, color: d.cornerDotColor },
      backgroundOptions: { color: d.bgTransparent ? 'transparent' : d.bgColor },
      image: d.logo || undefined,
      imageOptions: { hideBackgroundDots: !!d.logoHideDots, imageSize: Number(d.logoSize), margin: Number(d.logoMargin), crossOrigin: 'anonymous' },
    });
    const blob = await qr.getRawData('svg');
    let inner = await blob.text();
    inner = inner.replace(/^<\?xml[^>]*>\s*/, '');

    if (!d.frameOn) return ensureNs(inner);

    // Marco: borde de color + barra inferior con texto
    const pad = 36, label = d.frameText ? Math.round(Number(d.frameFont) * 1.9) : 0;
    const W = S + pad * 2, H = S + pad * 2 + label;
    const r = Number(d.frameRadius) || 0;
    const innerR = Math.max(0, r - pad / 2);
    const doc = new DOMParser().parseFromString(inner, 'image/svg+xml');
    const svgEl = doc.documentElement;
    svgEl.setAttribute('x', pad); svgEl.setAttribute('y', pad);
    svgEl.setAttribute('width', S); svgEl.setAttribute('height', S);
    if (!svgEl.getAttribute('viewBox')) svgEl.setAttribute('viewBox', `0 0 ${S} ${S}`);
    const innerStr = new XMLSerializer().serializeToString(svgEl);
    const qrBg = d.bgTransparent ? '#ffffff' : d.bgColor;
    const text = d.frameText ? `<text x="${W / 2}" y="${S + pad * 2 + label / 2}" text-anchor="middle" dominant-baseline="central"
      font-family="Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-weight="700" font-size="${Number(d.frameFont)}"
      fill="${esc(d.frameTextColor)}" letter-spacing="1">${esc(d.frameText)}</text>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <rect x="0" y="0" width="${W}" height="${H}" rx="${r}" ry="${r}" fill="${esc(d.frameColor)}"/>
      <rect x="${pad / 2}" y="${pad / 2}" width="${S + pad}" height="${S + pad}" rx="${innerR}" ry="${innerR}" fill="${esc(qrBg)}"/>
      ${innerStr}
      ${text}
    </svg>`;
  }

  function ensureNs(svg) {
    if (!/xmlns:xlink=/.test(svg) && /xlink:href/.test(svg)) svg = svg.replace('<svg', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
    if (!/xmlns=/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    return svg;
  }

  const svgToDataUrl = svg => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

  function svgSize(svg) {
    const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1000, h: 1000 };
  }

  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }

  async function rasterize(svg, width, mime, whiteBg) {
    const { w, h } = svgSize(svg);
    const scale = width / w;
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const ctx = c.getContext('2d');
    if (whiteBg) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); }
    const img = await loadImage(svgToDataUrl(svg));
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { canvas: c, dataUrl: c.toDataURL(mime, 0.95) };
  }

  function downloadUrl(url, filename) {
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  }

  const safeName = n => (n || 'codigo-qr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'codigo-qr';

  async function download(format, data, design, name, opts = {}) {
    const svg = await buildSvg(data, design);
    const base = safeName(name);
    const size = Number(opts.size) || 1024;
    if (format === 'svg') {
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      downloadUrl(url, base + '.svg');
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return;
    }
    if (format === 'pdf') {
      const { jsPDF } = window.jspdf;
      const { w, h } = svgSize(svg);
      const cmW = Number(opts.pdfCm) || 10;
      const mmW = cmW * 10, mmH = mmW * h / w;
      const { dataUrl } = await rasterize(svg, Math.max(2048, size), 'image/png', false);
      const pdf = new jsPDF({ orientation: mmW > mmH ? 'l' : 'p', unit: 'mm', format: [mmW, mmH] });
      pdf.addImage(dataUrl, 'PNG', 0, 0, mmW, mmH);
      pdf.save(base + '.pdf');
      return;
    }
    const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[format];
    const { dataUrl } = await rasterize(svg, size, mime, format === 'jpg');
    downloadUrl(dataUrl, `${base}.${format}`);
  }

  window.QRRender = { DEFAULT_DESIGN, buildSvg, svgToDataUrl, svgSize, rasterize, downloadUrl, download, safeName };
})();
