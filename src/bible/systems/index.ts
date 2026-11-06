// Every system the bible explains, in the order the contents list them. Each page is written from
// the rules it names and takes its numbers from the content and the rules (src/bible/kit.ts).

import type { SystemDef } from '../kit';
import { movingAndClimbing } from './moving';
import { swimmingAndGliding } from './swimming-gliding';
import { combat } from './combat';
import { skills } from './skills';
import { creatures } from './creatures';
import { farming } from './farming';
import { livestock } from './livestock';
import { trade } from './trade';
import { contracts } from './contracts';
import { housing } from './housing';
import { vehicles } from './vehicles';
import { quests } from './quests';
import { weather } from './weather';
import { world } from './world';
import { parties } from './parties';
import { minigames } from './minigames';
import { economy } from './economy';

export const SYSTEMS: readonly SystemDef[] = [
  movingAndClimbing,
  swimmingAndGliding,
  combat,
  skills,
  creatures,
  farming,
  livestock,
  trade,
  contracts,
  housing,
  vehicles,
  quests,
  weather,
  world,
  parties,
  minigames,
  economy,
];
