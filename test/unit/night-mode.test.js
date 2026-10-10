import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const code = readFileSync(
  new URL('../../extensions/media-tamer/night-mode.js', import.meta.url),
  'utf8',
);
function load() {
  const context = vm.createContext({});
  vm.runInContext(code, context);
  return vm.runInContext('VC_NIGHT_MODE', context);
}
function audio() {
  const nodes = [];
  const param = (value = 1) => ({
    value,
    setTargetAtTime(v) {
      this.value = v;
    },
  });
  return {
    nodes,
    currentTime: 0,
    createGain() {
      const n = {
        type: 'gain',
        gain: param(),
        edges: [],
        connect(x) {
          this.edges.push(x);
        },
        disconnect() {
          this.edges = [];
        },
      };
      nodes.push(n);
      return n;
    },
    createDynamicsCompressor() {
      const n = {
        type: 'compressor',
        threshold: param(),
        ratio: param(),
        knee: param(),
        attack: param(),
        release: param(),
        reduction: 0,
        edges: [],
        connect(x) {
          this.edges.push(x);
        },
        disconnect() {
          this.edges = [];
        },
      };
      nodes.push(n);
      return n;
    },
  };
}
test('steady enabled audio is not mixed with an undelayed dry signal', () => {
  const api = load();
  const ctx = audio();
  const helper = api.create(ctx);
  helper.setStrength(35);
  const comp = ctx.nodes.find((n) => n.type === 'compressor');
  const wet = comp.edges[0];
  const dry = helper.input.edges.find((n) => n.type === 'gain');
  assert.equal(wet.gain.value, 1);
  assert.equal(dry.gain.value, 0);
  helper.bypass();
  assert.equal(wet.gain.value, 0);
  assert.equal(dry.gain.value, 1);
});
test('invalid strength does not alter active settings', () => {
  const api = load();
  const helper = api.create(audio());
  helper.setStrength(70);
  for (const value of [NaN, Infinity, '50', null, undefined]) helper.setStrength(value);
  assert.equal(helper.getStatus().strength, 70);
});
test('classic namespace exposes the factories used by the volume content script', () => {
  const api = load();
  assert.equal(typeof api.create, 'function');
  assert.equal(typeof api.createOutputProtection, 'function');
  const ctx = audio();
  const helper = api.create(ctx);
  assert.equal(helper.getStatus().strength, 0);
});
