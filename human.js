'use strict';
/**
 * cloakfree/human.js - human-like mouse, keyboard and scroll behaviour.
 *
 * Port of the model in CloakBrowser's `human/` engine (MIT):
 *  - a pointer move is a fast bezier main stroke whose speed peaks early
 *    (time-warped minimum-jerk), timed by Fitts' law with a log-normal spread,
 *    sometimes missing the target and finished by a short corrective stroke;
 *  - pointer events go out at ~60 Hz and every point moves at least 1 px;
 *  - keystrokes follow the 136M-Keystrokes timing model: log-normal gaps that
 *    shrink across hands and grow after a space, key holds of 60-175 ms, and
 *    occasional typos on a neighbouring key that get noticed and corrected.
 *
 * Numbers are the 'default' preset from CloakBrowser's config.ts.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms > 0 ? ms : 0));
const rand = (min, max) => min + Math.random() * (max - min);
const randRange = ([a, b]) => rand(a, b);

const Z95 = 1.6449;
function gauss() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}
/** Log-normal sample with [lo, hi] as its ~5th/95th percentiles, clipped 0.5x-2x. */
function randLog([lo, hi]) {
  if (hi < lo) [lo, hi] = [hi, lo];
  if (lo <= 0) return rand(lo, hi);
  if (hi === lo) return lo;
  const mu = (Math.log(lo) + Math.log(hi)) / 2;
  const sigma = (Math.log(hi) - Math.log(lo)) / (2 * Z95);
  return Math.min(hi * 2, Math.max(lo / 2, Math.exp(mu + sigma * gauss())));
}
function randLognormal(median, sigma) {
  return median <= 0 ? 0 : sigma <= 0 ? median : median * Math.exp(sigma * gauss());
}

const CFG = {
  typing_delay: 150, typing_delay_spread: 70, typing_pause_chance: 0.15, typing_pause_range: [300, 1000],
  shift_down_delay: [60, 220], shift_up_delay: [-60, 30], key_hold: [60, 175],
  mistype_chance: 0.04, mistype_delay_notice: [100, 300], mistype_delay_correct: [50, 150],
  mouse_time_base: 160, mouse_time_per_bit: 75, mouse_time_spread: 0.3,
  mouse_min_steps: 2, mouse_max_steps: 200, mouse_wobble_max: 1.5,
  mouse_overshoot_chance: 0.35, mouse_overshoot_px: [2, 6],
  click_aim_delay_input: [60, 140], click_aim_delay_button: [80, 200],
  click_hold_input: [40, 100], click_hold_button: [60, 150], click_input_x_range: [0.05, 0.3],
  idle_drift_px: 3, idle_pause_range: [300, 1000],
  scroll_notch_px: 100, scroll_pause_fast: [30, 80], scroll_pause_slow: [80, 200],
  scroll_settle_delay: [300, 600], scroll_pre_move_delay: [100, 300],
};

const FRAME_MS = 1000 / 60;
const PEAK = [0.22, 0.38];

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t, uu = u * u, uuu = uu * u, tt = t * t, ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

/** Two control points bending the same way (a hand sweeps an arc, rarely an S). */
function controlPoints(s, e, curvature = 0.12) {
  const dx = e.x - s.x, dy = e.y - s.y;
  const dist = Math.hypot(dx, dy);
  const px = -dy / (dist || 1), py = dx / (dist || 1);
  const b1 = rand(-curvature, curvature) * dist;
  const b2 = Math.random() < 0.8 ? b1 * rand(0.2, 1.2) : rand(-curvature, curvature) * dist;
  return [
    { x: s.x + dx * 0.25 + px * b1, y: s.y + dy * 0.25 + py * b1 },
    { x: s.x + dx * 0.75 + px * b2, y: s.y + dy * 0.75 + py * b2 },
  ];
}

/** Distance 0->1 over time, speed peaking at `peak` of the stroke (fast start, slow tail). */
function progressCurve(peak) {
  const k = Math.log(0.5) / Math.log(peak);
  return (t) => {
    const u = Math.pow(t, k);
    return u * u * u * (10 - 15 * u + 6 * u * u);
  };
}

function strokeDuration(dist) {
  const median = CFG.mouse_time_base + CFG.mouse_time_per_bit * Math.log2(1 + dist / 8);
  return Math.max(FRAME_MS * 2, randLognormal(median, CFG.mouse_time_spread));
}

/** Planned pointer events for one stroke: [x, y, msSincePreviousPoint]. */
function planStroke(sx, sy, ex, ey, duration) {
  const dist = Math.hypot(ex - sx, ey - sy);
  if (dist < 0.5) return [];
  const total = duration ?? strokeDuration(dist);
  const n = Math.max(1, Math.trunc(Math.max(CFG.mouse_min_steps, Math.min(CFG.mouse_max_steps, Math.round(total / FRAME_MS)))));
  const start = { x: sx, y: sy }, end = { x: ex, y: ey };
  const [cp1, cp2] = controlPoints(start, end);
  const curve = progressCurve(rand(PEAK[0], PEAK[1]));
  const ux = (ex - sx) / dist, uy = (ey - sy) / dist;
  const amp = Math.min(CFG.mouse_wobble_max, dist * 0.02) * rand(-1, 1);
  const waves = rand(0.5, 1.5), phase = rand(0, Math.PI);
  const out = [];
  let lx = sx, ly = sy, tPrev = 0;
  for (let i = 1; i <= n; i++) {
    const t = Math.min(1, (i + (i < n ? rand(-0.2, 0.2) : 0)) / n);
    let x, y;
    if (i === n) {
      x = ex; y = ey;
      if (Math.abs(x - lx) < 1 && Math.abs(y - ly) < 1) {
        if (!out.length) break; // already there
        const [, , pdt] = out.pop();
        out.push([x, y, pdt + (t - tPrev) * total]);
        break;
      }
    } else {
      const p = bezier(start, cp1, cp2, end, curve(t));
      const w = amp * Math.sin(Math.PI * t) * Math.sin(phase + 2 * Math.PI * waves * t);
      x = Math.round(p.x - uy * w); y = Math.round(p.y + ux * w);
      if (Math.abs(x - lx) < 1 && Math.abs(y - ly) < 1) continue;
    }
    out.push([x, y, (t - tPrev) * total]);
    tPrev = t; lx = x; ly = y;
  }
  return out;
}

/** A whole move: main stroke, sometimes landing off-target then corrected. */
function planMove(sx, sy, ex, ey) {
  const dist = Math.hypot(ex - sx, ey - sy);
  if (dist < 0.5) return [];
  if (dist > 40 && Math.random() < CFG.mouse_overshoot_chance) {
    const ang = Math.atan2(ey - sy, ex - sx) + rand(-0.25, 0.25);
    let miss = dist * rand(0.01, 0.05) + randRange(CFG.mouse_overshoot_px);
    if (Math.random() < 0.3) miss = -miss;
    const mx = Math.round(ex + Math.cos(ang) * miss), my = Math.round(ey + Math.sin(ang) * miss);
    const pts = planStroke(sx, sy, mx, my);
    const corr = Math.hypot(ex - mx, ey - my);
    const tail = planStroke(mx, my, ex, ey, Math.max(FRAME_MS * 2, randLognormal(90 + 25 * Math.log2(1 + corr), 0.3)));
    if (tail.length) tail[0][2] += rand(40, 140);
    return pts.concat(tail);
  }
  return planStroke(sx, sy, ex, ey);
}

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

/** Move the real mouse along a planned stroke, in real time. */
async function move(page, x, y, from) {
  const start = from || { x: Math.round(rand(40, 700)), y: Math.round(rand(40, 90)) };
  let last = start;
  let clock = Date.now();
  for (const [px, py, dt] of planMove(last.x, last.y, x, y)) {
    clock += dt;
    const wait = clock - Date.now();
    if (wait > 0) await sleep(wait);
    await page.mouse.move(px, py);
    last = { x: px, y: py };
  }
  return last;
}

/** Move to a box (element bounding box) and click a human's spot inside it. */
async function clickBox(page, box, opts = {}) {
  const isInput = opts.isInput ?? false;
  let tx, ty;
  if (isInput) {
    tx = Math.round(box.x + box.width * randRange(CFG.click_input_x_range));
    ty = Math.round(box.y + box.height * rand(0.3, 0.7));
  } else {
    tx = Math.round(box.x + box.width * rand(0.35, 0.65));
    ty = Math.round(box.y + box.height * rand(0.35, 0.65));
  }
  await move(page, tx, ty, opts.from);
  await sleep(randRange(isInput ? CFG.click_aim_delay_input : CFG.click_aim_delay_button));
  await page.mouse.down();
  await sleep(randRange(isInput ? CFG.click_hold_input : CFG.click_hold_button));
  await page.mouse.up();
  return { x: tx, y: ty };
}

/** Click a point, with the approach and hold timing of a person. */
async function clickAt(page, x, y, opts = {}) {
  const box = { x, y, width: 1, height: 1 };
  return clickBox(page, box, { ...opts, isInput: opts.isInput ?? false });
}

/** Click a selector (locator) with a human approach. */
async function clickSelector(page, selector, opts = {}) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`human: no box for ${selector}`);
  return clickBox(page, box, opts);
}

/** Idle drift: tiny pointer movements in place, like a hand resting on the mouse. */
async function idle(page, seconds, cx, cy) {
  const dur = seconds ?? rand(0.4, 1.2);
  const end = Date.now() + dur * 1000;
  let x = cx ?? Math.round(rand(300, 900));
  let y = cy ?? Math.round(rand(300, 600));
  while (Date.now() < end) {
    x += (Math.random() - 0.5) * 2 * CFG.idle_drift_px;
    y += (Math.random() - 0.5) * 2 * CFG.idle_drift_px;
    await page.mouse.move(Math.round(x), Math.round(y));
    await sleep(randRange(CFG.idle_pause_range));
  }
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

const LEFT_HAND = new Set('qwertasdfgzxcvb`12345~!@#$%');
const SHIFT_SYMBOLS = new Set('@#!$%^&*()_+{}|:"<>?~');
const NEARBY = {
  a: 'sqwz', b: 'vghn', c: 'xdfv', d: 'sfecx', e: 'wrsdf', f: 'dgrtcv', g: 'fhtyb', h: 'gjybn',
  i: 'ujko', j: 'hkunm', k: 'jloi', l: 'kop', m: 'njk', n: 'bhjm', o: 'iklp', p: 'ol', q: 'wa',
  r: 'edft', s: 'awedxz', t: 'rfgy', u: 'yhji', v: 'cfgb', w: 'qase', x: 'zsdc', y: 'tghu', z: 'asx',
  1: '2', 2: '13', 3: '24', 4: '35', 5: '46', 6: '57', 7: '68', 8: '79', 9: '80', 0: '9',
};

function hand(ch) {
  const c = ch.toLowerCase();
  if (!c || c.length !== 1 || c.charCodeAt(0) > 127 || /\s/.test(c)) return null;
  return LEFT_HAND.has(c) ? 'L' : 'R';
}

/** How much slower (or faster) a key press follows the previous character. */
function gapFactor(prev, ch) {
  if (!prev) return 1;
  if (prev === ' ') return 1.3;
  if (ch === ' ') return 0.9;
  if (prev.toLowerCase() === ch.toLowerCase()) return 1.05;
  const hp = hand(prev), hc = hand(ch);
  if (hp && hc) return hp !== hc ? 0.85 : 1.1;
  return 1;
}

function keyGap(prev, ch) {
  const median = Math.max(1, CFG.typing_delay * gapFactor(prev, ch));
  const sigma = Math.log1p(CFG.typing_delay_spread / CFG.typing_delay);
  let gap = randLognormal(median, sigma);
  const wordStart = prev === ' ' || prev === '';
  if (Math.random() < CFG.typing_pause_chance * (wordStart ? 1 : 0.1)) gap += randRange(CFG.typing_pause_range);
  return Math.max(15, gap);
}

const keyHold = () => Math.max(1, randLog(CFG.key_hold));

/** Press one key the way a person does: hold 60-175 ms, Shift around capitals. */
async function pressChar(page, ch) {
  const shifted = (ch >= 'A' && ch <= 'Z') || SHIFT_SYMBOLS.has(ch);
  if (shifted) {
    await page.keyboard.down('Shift');
    await sleep(randLog(CFG.shift_down_delay));
    await page.keyboard.press(ch);
    await sleep(keyHold());
    await sleep(Math.max(0, randRange(CFG.shift_up_delay)));
    await page.keyboard.up('Shift');
  } else {
    await page.keyboard.down(ch);
    await sleep(keyHold());
    await page.keyboard.up(ch);
  }
}

function nearbyKey(ch) {
  const lower = ch.toLowerCase();
  const close = NEARBY[lower];
  if (!close) return ch;
  const wrong = close[Math.floor(Math.random() * close.length)];
  return ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? wrong.toUpperCase() : wrong;
}

/** Type text with human timing, rollover, thinking pauses and corrected typos. */
async function type(page, text, opts = {}) {
  const chars = [...String(text)];
  let prev = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch.codePointAt(0) > 127) {
      // No key produces it: it arrives as one input event, like an IME commit.
      await sleep(keyHold());
      await page.keyboard.insertText(ch);
    } else {
      if (/^[a-zA-Z0-9]$/.test(ch) && Math.random() < (opts.mistypeChance ?? CFG.mistype_chance)) {
        await pressChar(page, nearbyKey(ch));
        await sleep(randRange(CFG.mistype_delay_notice));
        await page.keyboard.press('Backspace');
        await sleep(randRange(CFG.mistype_delay_correct));
      }
      await pressChar(page, ch);
    }
    prev = ch;
    if (i < chars.length - 1) {
      await sleep(keyGap(prev === ' ' ? ' ' : prev, chars[i + 1]));
    }
  }
}

/** Click a field, then type into it. */
async function fill(page, selector, text, opts = {}) {
  await clickSelector(page, selector, { isInput: true });
  await sleep(randRange([120, 400]));
  if (opts.clear !== false) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await sleep(randRange([40, 120]));
    await page.keyboard.press('Backspace');
  }
  await type(page, text, opts);
}

// ---------------------------------------------------------------------------
// Scroll
// ---------------------------------------------------------------------------

/** Scroll by `px` in wheel notches: fast, then slowing, then a settle pause. */
async function scroll(page, px) {
  let remaining = Math.abs(px);
  const dir = px < 0 ? -1 : 1;
  const notch = CFG.scroll_notch_px;
  let n = 0;
  while (remaining > 0) {
    const step = Math.min(notch, remaining);
    await page.mouse.wheel(0, dir * step);
    remaining -= step;
    n++;
    const fast = n <= 3;
    await sleep(randRange(fast ? CFG.scroll_pause_fast : CFG.scroll_pause_slow));
  }
  await sleep(randRange(CFG.scroll_settle_delay));
}

/** Bring a selector into view the way a person would: scroll near it, then nudge. */
async function scrollTo(page, selector) {
  const box = await page.locator(selector).first().boundingBox().catch(() => null);
  if (!box) return;
  const vh = page.viewportSize()?.height || 800;
  const target = box.y + box.height / 2 - vh * randRange([0.2, 0.8]);
  if (Math.abs(target) > 40) await scroll(page, Math.round(target));
}

/** Attach the whole toolkit to a page as `page.human`. */
function humanize(page) {
  page.human = {
    move: (x, y, from) => move(page, x, y, from),
    clickAt: (x, y, opts) => clickAt(page, x, y, opts),
    click: (selector, opts) => clickSelector(page, selector, opts),
    clickBox: (box, opts) => clickBox(page, box, opts),
    type: (text, opts) => type(page, text, opts),
    fill: (selector, text, opts) => fill(page, selector, text, opts),
    idle: (seconds, cx, cy) => idle(page, seconds, cx, cy),
    scroll: (px) => scroll(page, px),
    scrollTo: (selector) => scrollTo(page, selector),
  };
  return page;
}

module.exports = {
  humanize, move, clickAt, clickBox, clickSelector, click: clickSelector,
  type, fill, idle, scroll, scrollTo, planMove, planStroke, CFG,
};
