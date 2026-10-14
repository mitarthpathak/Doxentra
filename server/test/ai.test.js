import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResult, buildFallbackGraph } from '../lib/ai.js';

test('normalizeResult builds a single-root tree with parent edges', () => {
  const { graph, metadata } = normalizeResult({
    metadata: { title: 'Cells', description: 'd', complexity: 42, category: 'Biology', roadmap: [{ title: 'A', desc: 'a' }, { title: 'B', desc: 'b' }], relatedModules: [{ icon: 'science', title: 'X', desc: 'x' }] },
    nodes: [
      { id: 'r', label: 'Cell', type: 'major' },
      { id: 'r2', label: 'Second root', type: 'major' },
      { id: 'h', label: 'Organelles', type: 'header', parentId: 'r' },
      { id: 'h', label: 'Duplicate id', type: 'header', parentId: 'r' },
      { id: 's', label: 'Mitochondria', type: 'sub-topic', parentId: 'h' },
      { id: 'o', label: 'Orphan', type: 'concept', parentId: 'missing' },
      { id: 'x', label: '' },
    ],
    links: [{ from: 's', to: 'o', label: 'relates' }, { from: 'nope', to: 's', label: 'bad' }],
  });

  assert.equal(graph.nodes.filter(n => n.type === 'major').length, 1);
  assert.equal(new Set(graph.nodes.map(n => n.id)).size, graph.nodes.length, 'ids are unique');
  assert.equal(graph.nodes.length, 6, 'empty labels dropped');
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  for (const n of graph.nodes) if (n.type !== 'major') assert.ok(byId.has(n.parentId), `${n.label} has a parent`);
  for (const e of graph.edges) assert.ok(byId.has(e.source) && byId.has(e.target));
  assert.ok(graph.edges.some(e => e.label === 'relates'));
  assert.ok(!graph.edges.some(e => e.label === 'bad'));
  assert.equal(metadata.complexity, 10, 'complexity clamped');
  assert.deepEqual(metadata.roadmap.map(r => r.status), ['completed', 'in-progress']);
});

test('normalizeResult breaks parent cycles', () => {
  const { graph } = normalizeResult({
    nodes: [
      { id: 'r', label: 'Root', type: 'major' },
      { id: 'a', label: 'A', type: 'header', parentId: 'b' },
      { id: 'b', label: 'B', type: 'header', parentId: 'a' },
    ],
  });
  const root = graph.nodes.find(n => n.type === 'major');
  assert.ok(graph.nodes.filter(n => n !== root).some(n => n.parentId === root.id));
});

test('normalizeResult rejects an empty graph', () => {
  assert.throws(() => normalizeResult({ nodes: [] }), /empty graph/);
});

test('fallback graph is a connected tree', () => {
  const { graph, metadata } = buildFallbackGraph('neuron neuron neuron synapse synapse axon dendrite signal signal cortex memory learning');
  assert.equal(graph.nodes[0].type, 'major');
  assert.equal(graph.edges.length, graph.nodes.length - 1);
  assert.ok(metadata.title);
});
