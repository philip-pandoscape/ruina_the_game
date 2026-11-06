// Procedural 3D models for the island: vehicles, mounts, gliders, trade packs, crops, buildings
// and props. Everything faces +Z with +Y up and its right-hand side at -X; sizes come from the
// shared/*.json data. The content library shows them all (/dev/library.html#/models).

export { buildVehicle, type VehicleAnim, type VehicleModel } from './vehicles';
export { buildMount, type MountAnim, type MountModel } from './mounts';
export { buildGlider, type GliderAnim, type GliderModel } from './gliders';
export { buildPack, PACK_IDS, PACK_SIZE } from './packs';
export { buildAnimal, type AnimalAnim, type AnimalModel } from './animals';
export { buildVillager, type VillagerAnim, type VillagerModel } from './villagers';
export { cropGeometry, cropStages, buildCrop } from './crops';
export { buildStructure, type StructureModel, type StructureOpts } from './structures';
export { propGeometry } from './props';
export { PAL, vcMaterial, clothMaterial, glowMaterial, tint, faceted, merge, Parts } from './kit';
