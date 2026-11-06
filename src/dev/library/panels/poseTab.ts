import type { App } from '../app';
import { h, icon } from '../dom';
import { SIDE_COLOURS } from '../overlay';
import { eulerDeg, modelPositions, readJoint } from '../pose';
import type { Take } from '../types';

// The Pose tab: how to start correcting a frame; while correcting, the tools (turn, move, scale,
// undo), the picked bone's turn in degrees (typed in, or followed as a handle is dragged) and where
// its joint is, keeping or throwing away the correction; and every bone, by depth, to pick from.

export class PoseTab {
  constructor(private readonly app: App) {}

  render(): void {
    const app = this.app;
    if (app.tab !== 'pose') return;
    const pane = app.el.pane;
    const scroll = pane.scrollTop;
    pane.replaceChildren();
    const take = app.take;
    if (!take) return;
    if (!app.editor.active) {
      pane.append(
        h(
          'div',
          { class: 'callout' },
          h('p', {}, 'Show Claude where the bones should be: pause on a frame, then move its joints.'),
          h(
            'p',
            { class: 'muted' },
            'Click a joint in the picture (or below) to pick it. ',
            h('kbd', {}, 'R'),
            ' turns it with a gizmo; ',
            h('kbd', {}, 'G'),
            ' moves a hand or a foot and bends the limb to reach. The frame as it was stays as a grey ghost.',
          ),
          h(
            'button',
            { class: 'btn primary', onclick: () => app.posing.enter() },
            icon('edit'),
            h('span', { 'data-frame-label': 'Correct Frame' }, `Correct Frame ${app.frame}`),
          ),
        ),
      );
      pane.append(h('h3', { style: 'margin-top:16px' }, 'Bones'), this.boneList(take));
      pane.scrollTop = scroll;
      return;
    }
    const ed = app.editor;
    pane.append(
      h(
        'div',
        { class: 'tools' },
        h('button', { class: `btn small${ed.tool === 'rotate' ? ' on' : ''}`, onclick: () => ed.setTool('rotate'), title: 'Turn (R)' }, icon('rotate'), 'Turn'),
        h(
          'button',
          {
            class: `btn small${ed.tool === 'move' ? ' on' : ''}`,
            onclick: () => ed.setTool('move'),
            title: 'Move: a hand or a foot reaches, others slide (G)',
          },
          icon('move'),
          'Move',
        ),
        h(
          'button',
          { class: `btn small${ed.tool === 'scale' ? ' on' : ''}`, onclick: () => ed.setTool('scale'), title: 'Squash and stretch (S)' },
          icon('scale'),
          'Scale',
        ),
        h('button', { class: 'icon-btn', title: 'Undo (Ctrl+Z)', onclick: () => ed.undo() }, icon('undo')),
        h('button', { class: 'icon-btn', title: 'Redo (Ctrl+Shift+Z)', onclick: () => ed.redo() }, icon('redo')),
      ),
    );
    const b = ed.selected;
    if (b) {
      const pose = readJoint(b.object);
      const e = eulerDeg(pose);
      const field = (axis: 'x' | 'y' | 'z', i: number) => {
        const input = h('input', { type: 'number', step: '1', value: e[i].toFixed(1) });
        input.onchange = () => {
          const next: [number, number, number] = [...e] as [number, number, number];
          next[i] = Number(input.value) || 0;
          ed.setEuler(next);
        };
        input.onkeydown = (ev) => ev.stopPropagation();
        return h('label', { class: axis }, h('b', {}, axis.toUpperCase()), input, '°');
      };
      take.root.updateMatrixWorld(true);
      const model = modelPositions(take)[b.name] ?? [0, 0, 0];
      const chain = ed.chainOf(b);
      pane.append(
        h(
          'div',
          { class: 'bone-card' },
          h(
            'div',
            { class: 'title' },
            h('span', { class: 'sw', style: `background:#${SIDE_COLOURS[b.side].toString(16).padStart(6, '0')}` }),
            b.name,
            h('span', { class: 'muted', style: 'font-weight:400;font-size:12px' }, b.parent ? `in ${b.parent}` : ''),
          ),
          h('div', { class: 'xyz' }, field('x', 0), field('y', 1), field('z', 2)),
          h('div', { class: 'readout' }, `Turn in its parent's space (XYZ). Joint at ${model.map((v) => v.toFixed(3)).join(', ')} m in the body.`),
          h(
            'div',
            { class: 'readout' },
            ed.tool === 'move'
              ? chain
                ? `Move bends ${chain[0].name} and ${chain[1].name} to reach.`
                : 'Move slides this joint.'
              : ed.tool === 'scale'
                ? `Scale ${b.object.scale
                    .toArray()
                    .map((v) => v.toFixed(2))
                    .join(' × ')}: drag a handle, or the centre for all three.`
                : 'Drag the gizmo’s rings to turn it.',
          ),
          h(
            'div',
            { class: 'row', style: 'display:flex;gap:6px;margin-top:8px' },
            h('button', { class: 'btn small', onclick: () => ed.reset(b), disabled: !ed.touched.has(b.name) }, icon('reset'), 'Reset Bone'),
            h('button', { class: 'btn small', onclick: () => ed.reset(), disabled: !ed.dirty }, 'Reset All'),
          ),
        ),
      );
    } else
      pane.append(h('div', { class: 'callout', style: 'margin-bottom:12px' }, h('p', { style: 'margin:0' }, 'Click a joint in the picture, or a bone below.')));
    pane.append(
      h(
        'div',
        { style: 'display:flex;gap:6px;margin-bottom:14px' },
        h('button', { class: 'btn primary', style: 'flex:1', onclick: () => void app.posing.save(), disabled: !ed.dirty }, icon('check'), 'Save Correction…'),
        h('button', { class: 'btn', onclick: () => app.posing.discard() }, 'Discard'),
      ),
    );
    pane.append(h('h3', {}, 'Bones'), this.boneList(take));
    pane.scrollTop = scroll;
  }

  /** The selected bone's numbers, as a handle is dragged. */
  updateNumbers(): void {
    const app = this.app;
    const b = app.editor.selected;
    if (!b || app.tab !== 'pose') return;
    const e = eulerDeg(readJoint(b.object));
    app.el.pane.querySelectorAll<HTMLInputElement>('.xyz input').forEach((input, i) => {
      if (input !== document.activeElement) input.value = e[i].toFixed(1);
    });
  }

  private boneList(take: Take): HTMLElement {
    const app = this.app;
    const list = h('div', { class: 'bone-list' });
    const depth = new Map<string, number>();
    for (const b of take.bones) depth.set(b.name, b.parent ? (depth.get(b.parent) ?? 0) + 1 : 0);
    for (const b of take.bones) {
      const on = app.editor.selected?.name === b.name;
      list.append(
        h(
          'button',
          {
            class: `bone-row${on ? ' on' : ''}${b.locked ? ' locked' : ''}`,
            style: `padding-left:${8 + Math.min(10, depth.get(b.name) ?? 0) * 10}px`,
            title: b.locked ? 'Not for posing' : '',
            onclick: () => {
              if (b.locked) return;
              if (!app.editor.active) app.posing.enter(b);
              else app.editor.select(b);
            },
          },
          h('span', { class: 'sw', style: `background:#${SIDE_COLOURS[b.side].toString(16).padStart(6, '0')}` }),
          b.name,
          app.editor.touched.has(b.name) ? h('span', { class: 'touched' }, 'moved') : null,
        ),
      );
    }
    return list;
  }
}
