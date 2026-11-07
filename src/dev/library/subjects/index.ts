import type { Subject } from '../types';
import { heroSubject } from './hero';
import { speciesSubjects } from './species';
import { modelSubjects } from './models';
import { retargetSubject } from './retarget';
import { rigSubjects } from './rigs';
import { buildingsSubject } from '../galleries/buildings';
import { crowdsSubject } from '../galleries/crowds';
import { modelsSubject } from '../galleries/models';
import { uiSubject } from '../galleries/ui';

// Everything the library can show, in the order it lists them. A new character (a goblin, a
// villager with a rig) is an adapter like hero.ts and a line here; a new gallery is one like
// galleries/models.ts.

export const SUBJECTS: Subject[] = [
  heroSubject,
  retargetSubject,
  ...speciesSubjects,
  ...modelSubjects,
  ...rigSubjects,
  modelsSubject,
  buildingsSubject,
  crowdsSubject,
  uiSubject,
];

export const subjectById = (id: string): Subject | undefined => SUBJECTS.find((s) => s.id === id);

export const GROUP_ORDER = ['Heroes', 'Mobs', 'Creatures', 'Townsfolk', 'Mounts', 'Crowd', 'Rigs', 'Galleries'];
