import type { Subject } from '../types';
import { heroSubject } from './hero';
import { speciesSubjects } from './species';
import { modelSubjects } from './models';

// Everything the library can show, in the order it lists them. A new character (a goblin, a
// villager with a rig) is an adapter like hero.ts and a line here.

export const SUBJECTS: Subject[] = [heroSubject, ...speciesSubjects, ...modelSubjects];

export const subjectById = (id: string): Subject | undefined => SUBJECTS.find((s) => s.id === id);

export const GROUP_ORDER = ['Heroes', 'Mobs', 'Creatures', 'Townsfolk', 'Mounts', 'Crowd'];
