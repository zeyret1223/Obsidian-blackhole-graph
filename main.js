'use strict';
const { Plugin, ItemView, PluginSettingTab, Setting, debounce } = require('obsidian');

const VIEW_TYPE = 'blackhole-graph-view';
const TAU = Math.PI * 2;

const DEFAULT_SETTINGS = {
  speed: 1,
  tilt: 0.36,
  rotation: -14,
  showLinks: true,
  linkOpacity: 0.14,
  showOrphans: true,
  nodeScale: 1,
  showLabels: true,
};

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class BlackHoleView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.nodes = [];
    this.edges = [];
    this.hubs = [];
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.hover = null;
    this.nbr = new Set();
    this.ts = 1; // time scale (slows down while hovering)
    this.w = 1;
    this.h = 1;
    this.geo = { cx: 0, cy: 0, Rh: 0 };
    this.frame = this.frame.bind(this);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return '黑洞图谱'; }
  getIcon() { return 'circle-dot'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('bh-root');
    this.canvas = root.createEl('canvas', { cls: 'bh-canvas' });
    this.ctx = this.canvas.getContext('2d');

    this.buildGraph();
    this.bindEvents();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(root);
    this.resize();

    this.registerEvent(
      this.app.metadataCache.on('resolved', debounce(() => this.buildGraph(), 800, true))
    );

    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  async onClose() {
    cancelAnimationFrame(this.raf);
    if (this.ro) this.ro.disconnect();
  }

  // ---------- data ----------
  buildGraph() {
    const s = this.plugin.settings;
    const files = this.app.vault.getMarkdownFiles();
    const links = this.app.metadataCache.resolvedLinks;

    const idx = new Map();
    let nodes = files.map((f, i) => {
      idx.set(f.path, i);
      return { path: f.path, name: f.basename, deg: 0, adj: [] };
    });

    const edges = [];
    const seen = new Set();
    for (const [src, targets] of Object.entries(links)) {
      const a = idx.get(src);
      if (a === undefined) continue;
      for (const tgt of Object.keys(targets)) {
        const b = idx.get(tgt);
        if (b === undefined || a === b) continue;
        const key = a < b ? a + '_' + b : b + '_' + a;
        if (seen.has(key)) continue;
        seen.add(key);
        const A = nodes[a], B = nodes[b];
        A.deg++; B.deg++;
        A.adj.push(B); B.adj.push(A);
        edges.push([A, B]);
      }
    }

    if (!s.showOrphans) nodes = nodes.filter((n) => n.deg > 0);

    // community detection (simple label propagation) -> angular sectors
    nodes.forEach((n, i) => { n.id = i; n.label = i; });
    for (let it = 0; it < 10; it++) {
      let changed = false;
      for (const n of nodes) {
        if (!n.adj.length) continue;
        const cnt = new Map();
        for (const m of n.adj) cnt.set(m.label, (cnt.get(m.label) || 0) + 1);
        let best = n.label, bc = -1;
        for (const [l, c] of cnt) {
          if (c > bc || (c === bc && l < best)) { best = l; bc = c; }
        }
        if (best !== n.label) { n.label = best; changed = true; }
      }
      if (!changed) break;
    }

    const conn = nodes.filter((n) => n.deg > 0).sort((a, b) => b.deg - a.deg);
    const groups = new Map();
    for (const n of conn) {
      if (!groups.has(n.label)) groups.set(n.label, []);
      groups.get(n.label).push(n);
    }
    const groupList = [...groups.values()].sort((a, b) => b.length - a.length);
    const total = Math.max(1, conn.length);
    let acc = 0;
    const sector = new Map();
    for (const g of groupList) {
      const start = (acc / total) * TAU;
      const width = (g.length / total) * TAU;
      sector.set(g, [start, width]);
      acc += g.length;
    }

    // radius by degree rank: hubs near the black hole, leaves far away
    conn.forEach((n, i) => {
      const t = conn.length > 1 ? i / (conn.length - 1) : 0;
      n.t = t;
      n.orphan = false;
    });

    for (const n of nodes) {
      const rnd = mulberry32(hashStr(n.path));
      if (n.deg > 0) {
        n.r = (0.2 + 0.78 * Math.pow(n.t, 0.85)) * (1 + (rnd() - 0.5) * 0.06);
      } else {
        n.orphan = true;
        n.t = 1;
        n.r = 1.04 + rnd() * 0.36;
      }
      n.z = (rnd() - 0.5) * (0.02 + 0.05 * Math.min(n.r, 1));
      n.w = 0.2 * Math.pow(0.35 / n.r, 1.5);

      if (n.orphan) {
        n.theta = rnd() * TAU;
      } else {
        const g = groups.get(n.label);
        const [st, wd] = sector.get(g);
        n.theta = st + rnd() * wd;
      }

      // colour: hot blue-white inside -> deep indigo outside, a few pink sparks
      const t = Math.min(1, Math.max(0, (n.r - 0.2) / 0.8));
      let hue = 200 + t * 70;
      if (rnd() < 0.08) hue = 320 + rnd() * 30;
      const sat = 55 + t * 30 + rnd() * 10;
      const light = 88 - t * 32;
      n.col = [Math.round(hue), Math.round(sat), Math.round(light)];
      n.sx = n.sy = 0;
      n.sz = 2;
      n.depth = 0;
      n.u = 1;
    }

    this.nodes = nodes;
    this.edges = edges;
    this.hubs = conn.slice(0, 10);
    this.hover = null;
    this.nbr = new Set();
  }

  // ---------- interaction ----------
  bindEvents() {
    const c = this.canvas;
    let drag = null;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    this.registerDomEvent(c, 'pointerdown', (e) => {
      const [x, y] = pos(e);
      drag = { x, y, px: this.panX, py: this.panY, moved: false };
      try { c.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      c.addClass('bh-grabbing');
    });

    this.registerDomEvent(c, 'pointermove', (e) => {
      const [x, y] = pos(e);
      if (drag) {
        const dx = x - drag.x, dy = y - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          this.panX = drag.px + dx;
          this.panY = drag.py + dy;
        }
      } else {
        this.pick(x, y);
      }
    });

    this.registerDomEvent(c, 'pointerup', (e) => {
      const [x, y] = pos(e);
      c.removeClass('bh-grabbing');
      if (drag && !drag.moved) {
        this.pick(x, y);
        if (this.hover) this.openNode(this.hover, e.ctrlKey || e.metaKey);
      }
      drag = null;
    });

    this.registerDomEvent(c, 'pointerleave', () => {
      if (!drag) this.setHover(null);
    });

    this.registerDomEvent(
      c,
      'wheel',
      (e) => {
        e.preventDefault();
        const [x, y] = pos(e);
        const f = Math.exp(-e.deltaY * 0.0015);
        const nz = Math.min(6, Math.max(0.3, this.zoom * f));
        const k = nz / this.zoom;
        const cx = this.w / 2, cy = this.h / 2;
        this.panX = x - cx - (x - cx - this.panX) * k;
        this.panY = y - cy - (y - cy - this.panY) * k;
        this.zoom = nz;
      },
      { passive: false }
    );

    this.registerDomEvent(c, 'dblclick', () => {
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
    });
  }

  setHover(n) {
    if (n === this.hover) return;
    this.hover = n;
    this.nbr = n ? new Set(n.adj) : new Set();
    if (this.canvas) this.canvas.style.cursor = n ? 'pointer' : '';
  }

  pick(x, y) {
    const { cx, cy, Rh } = this.geo;
    let best = null, bd = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(n.sx - x, n.sy - y);
      const lim = Math.max(n.sz, 3) + 6;
      if (d >= lim || d >= bd) continue;
      if (n.depth < 0 && Math.hypot(n.sx - cx, n.sy - cy) < Rh * 1.05) continue; // hidden behind the hole
      bd = d;
      best = n;
    }
    this.setHover(best);
  }

  openNode(n, newTab) {
    const file = this.app.vault.getAbstractFileByPath(n.path);
    if (!file) return;
    const ws = this.app.workspace;
    let leaf = this.targetLeaf;
    const alive = leaf && ws.getLeavesOfType('markdown').includes(leaf);
    if (newTab || !alive) {
      leaf = ws.getLeaf(newTab ? 'tab' : 'split', 'vertical');
      this.targetLeaf = leaf;
    }
    leaf.openFile(file);
  }

  // ---------- rendering ----------
  resize() {
    const r = this.contentEl.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // static starfield
    const sc = document.createElement('canvas');
    sc.width = this.canvas.width;
    sc.height = this.canvas.height;
    const g = sc.getContext('2d');
    g.scale(dpr, dpr);
    const rnd = mulberry32(7);
    const count = Math.floor((this.w * this.h) / 4500);
    for (let i = 0; i < count; i++) {
      const big = rnd() < 0.08;
      g.fillStyle = `rgba(255,255,255,${0.08 + rnd() * 0.45})`;
      const sz = big ? 1.6 : 1;
      g.fillRect(rnd() * this.w, rnd() * this.h, sz, sz);
    }
    this.stars = sc;
  }

  frame(now) {
    this.raf = requestAnimationFrame(this.frame);
    if (!this.contentEl.isShown()) {
      this.last = now;
      return;
    }
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const target = this.hover ? 0.1 : 1;
    this.ts += (target - this.ts) * Math.min(1, dt * 6);
    const adv = dt * this.ts * this.plugin.settings.speed;
    for (const n of this.nodes) n.theta += n.w * adv;
    this.draw();
  }

  draw() {
    const ctx = this.ctx, W = this.w, H = this.h, s = this.plugin.settings;
    const tilt = s.tilt;
    const phi = (s.rotation * Math.PI) / 180;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const R = Math.min(W * 0.46, (H * 0.46) / Math.max(tilt, 0.3)) * this.zoom;
    const cx = W / 2 + this.panX, cy = H / 2 + this.panY;
    const Rh = R * 0.12;
    this.geo = { cx, cy, Rh };
    const nodes = this.nodes, hov = this.hover;

    // background
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#02030a';
    ctx.fillRect(0, 0, W, H);
    if (this.stars) ctx.drawImage(this.stars, 0, 0, W, H);

    // accretion-disk haze (tilted ellipse)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(phi);
    ctx.scale(1, tilt);
    let g = ctx.createRadialGradient(0, 0, Rh * 0.8, 0, 0, R * 1.2);
    g.addColorStop(0, 'rgba(190,215,255,0.40)');
    g.addColorStop(0.15, 'rgba(110,140,255,0.22)');
    g.addColorStop(0.5, 'rgba(70,70,200,0.09)');
    g.addColorStop(1, 'rgba(40,30,120,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.2, 0, TAU);
    ctx.fill();
    ctx.restore();

    // project nodes
    const far = [], near = [];
    for (const n of nodes) {
      const c = Math.cos(n.theta), sn = Math.sin(n.theta);
      const x = n.r * c, y = n.r * sn * tilt + n.z;
      n.sx = cx + (x * cp - y * sp) * R;
      n.sy = cy + (x * sp + y * cp) * R;
      n.depth = sn;
      n.u = c;
      const df = 0.5 + 0.5 * sn;
      n.sz = (1.5 + Math.sqrt(n.deg) * 0.9) * s.nodeScale * (0.75 + 0.5 * df) * Math.sqrt(this.zoom);
      (sn < 0 ? far : near).push(n);
    }

    // links: curves bowed toward the black hole
    ctx.globalCompositeOperation = 'lighter';
    if (s.showLinks) {
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = `rgba(130,160,255,${s.linkOpacity * (hov ? 0.5 : 1)})`;
      ctx.beginPath();
      for (const [A, B] of this.edges) {
        const mx = (A.sx + B.sx) / 2, my = (A.sy + B.sy) / 2;
        ctx.moveTo(A.sx, A.sy);
        ctx.quadraticCurveTo(mx + (cx - mx) * 0.35, my + (cy - my) * 0.35, B.sx, B.sy);
      }
      ctx.stroke();
      if (hov) {
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(200,220,255,0.75)';
        ctx.beginPath();
        for (const B of hov.adj) {
          const mx = (hov.sx + B.sx) / 2, my = (hov.sy + B.sy) / 2;
          ctx.moveTo(hov.sx, hov.sy);
          ctx.quadraticCurveTo(mx + (cx - mx) * 0.35, my + (cy - my) * 0.35, B.sx, B.sy);
        }
        ctx.stroke();
      }
    }

    const dot = (n, px, py, size, alpha) => {
      const dim = hov && n !== hov && !this.nbr.has(n) ? 0.3 : 1;
      const a = alpha * dim;
      const [h, sa, l] = n.col;
      ctx.fillStyle = `hsla(${h},${sa}%,${l}%,${a * 0.16})`;
      ctx.beginPath();
      ctx.arc(px, py, size * 2.8, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `hsla(${h},${sa}%,${l}%,${a})`;
      ctx.beginPath();
      ctx.arc(px, py, size, 0, TAU);
      ctx.fill();
    };
    const nodeAlpha = (n) => (n.orphan ? 0.5 : 0.95) * (0.5 + 0.5 * (0.5 + 0.5 * n.depth));

    // far side of the disk (partly hidden by the hole) + lensed images over the top
    for (const n of far) {
      dot(n, n.sx, n.sy, n.sz, nodeAlpha(n));
      if (!n.orphan && n.r < 0.65) {
        const rl = Rh * (1.2 + 0.8 * n.r);
        const al = Math.PI + ((n.u + 1) / 2) * Math.PI;
        const lx = Math.cos(al) * rl, ly = Math.sin(al) * rl;
        dot(n, cx + lx * cp - ly * sp, cy + lx * sp + ly * cp, n.sz * 0.7, 0.35);
      }
    }

    // the black hole
    ctx.globalCompositeOperation = 'source-over';
    g = ctx.createRadialGradient(cx, cy, Rh * 0.9, cx, cy, Rh * 2.3);
    g.addColorStop(0, 'rgba(150,190,255,0.55)');
    g.addColorStop(0.35, 'rgba(90,120,255,0.25)');
    g.addColorStop(1, 'rgba(40,50,160,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, Rh * 2.3, 0, TAU);
    ctx.fill();

    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(cx, cy, Rh, 0, TAU);
    ctx.fill();

    ctx.shadowColor = 'rgba(150,190,255,0.9)';
    ctx.shadowBlur = Rh * 0.6;
    ctx.lineWidth = Math.max(1, Rh * 0.05);
    ctx.strokeStyle = 'rgba(225,240,255,0.95)';
    ctx.beginPath();
    ctx.arc(cx, cy, Rh * 1.02, 0, TAU);
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(phi);
    ctx.lineWidth = Math.max(1.5, Rh * 0.1);
    ctx.strokeStyle = 'rgba(210,230,255,0.85)';
    ctx.beginPath();
    ctx.arc(0, 0, Rh * 1.12, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, Rh * 0.03);
    ctx.strokeStyle = 'rgba(180,205,255,0.35)';
    ctx.beginPath();
    ctx.arc(0, 0, Rh * 1.1, Math.PI * 0.1, Math.PI * 0.9);
    ctx.stroke();
    ctx.restore();
    ctx.shadowBlur = 0;

    // near side of the disk, in front of the hole
    ctx.globalCompositeOperation = 'lighter';
    for (const n of near) dot(n, n.sx, n.sy, n.sz, nodeAlpha(n));
    ctx.globalCompositeOperation = 'source-over';

    // labels
    ctx.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'alphabetic';
    const label = (n, strong) => {
      ctx.fillStyle = strong ? 'rgba(240,245,255,0.98)' : 'rgba(200,215,255,0.6)';
      ctx.shadowColor = 'rgba(0,0,20,0.95)';
      ctx.shadowBlur = 4;
      ctx.fillText(n.name, n.sx + n.sz + 6, n.sy + 4);
      ctx.shadowBlur = 0;
    };
    if (s.showLabels && !hov) {
      for (const n of this.hubs) if (n.depth >= -0.1) label(n, false);
    }
    if (hov) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(hov.sx, hov.sy, hov.sz + 3, 0, TAU);
      ctx.stroke();
      label(hov, true);
      for (const n of hov.adj) if (n.depth >= 0) label(n, false);
    }

    // HUD
    ctx.fillStyle = 'rgba(160,180,230,0.5)';
    ctx.fillText(`${nodes.length} 个知识点 · ${this.edges.length} 条链接`, 14, H - 30);
    ctx.fillText('滚轮缩放 · 拖拽平移 · 双击复位 · 点击打开笔记（Ctrl/⌘ 新标签页）', 14, H - 12);
  }
}

class BlackHoleSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const p = this.plugin;
    const save = async (rebuild) => {
      await p.saveSettings();
      if (rebuild) p.getViews().forEach((v) => v.buildGraph());
    };

    new Setting(containerEl).setName('旋转速度').addSlider((sl) =>
      sl.setLimits(0, 3, 0.1).setValue(p.settings.speed).setDynamicTooltip()
        .onChange(async (v) => { p.settings.speed = v; await save(); }));

    new Setting(containerEl).setName('圆盘倾斜度').setDesc('数值越小，圆盘越扁')
      .addSlider((sl) =>
        sl.setLimits(0.15, 0.9, 0.01).setValue(p.settings.tilt).setDynamicTooltip()
          .onChange(async (v) => { p.settings.tilt = v; await save(); }));

    new Setting(containerEl).setName('圆盘旋转角度').addSlider((sl) =>
      sl.setLimits(-45, 45, 1).setValue(p.settings.rotation).setDynamicTooltip()
        .onChange(async (v) => { p.settings.rotation = v; await save(); }));

    new Setting(containerEl).setName('节点大小').addSlider((sl) =>
      sl.setLimits(0.5, 2.5, 0.1).setValue(p.settings.nodeScale).setDynamicTooltip()
        .onChange(async (v) => { p.settings.nodeScale = v; await save(); }));

    new Setting(containerEl).setName('显示链接线').addToggle((t) =>
      t.setValue(p.settings.showLinks).onChange(async (v) => { p.settings.showLinks = v; await save(); }));

    new Setting(containerEl).setName('链接线亮度').addSlider((sl) =>
      sl.setLimits(0.02, 0.5, 0.01).setValue(p.settings.linkOpacity).setDynamicTooltip()
        .onChange(async (v) => { p.settings.linkOpacity = v; await save(); }));

    new Setting(containerEl).setName('显示孤立笔记').setDesc('没有任何链接的笔记，会作为外围尘埃缓慢漂移')
      .addToggle((t) =>
        t.setValue(p.settings.showOrphans).onChange(async (v) => { p.settings.showOrphans = v; await save(true); }));

    new Setting(containerEl).setName('显示核心笔记名称').addToggle((t) =>
      t.setValue(p.settings.showLabels).onChange(async (v) => { p.settings.showLabels = v; await save(); }));
  }
}

module.exports = class BlackHoleGraphPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new BlackHoleView(leaf, this));
    this.addRibbonIcon('circle-dot', '打开黑洞图谱', () => this.activate());
    this.addCommand({
      id: 'open-blackhole-graph',
      name: '打开黑洞图谱',
      callback: () => this.activate(),
    });
    this.addSettingTab(new BlackHoleSettingTab(this.app, this));
  }

  getViews() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view);
  }

  async activate() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    ws.revealLeaf(leaf);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
