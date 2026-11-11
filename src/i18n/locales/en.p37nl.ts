/** Phase 37 natural-language parser: questions about a missing piece, "not understood" reasons, suggestions. */
export const enP37Nl = {
  // One piece is missing — nothing runs until it is given.
  'cmd37.nl.ask.direction': 'Which way? Say a compass direction (north / south / east / west, up / down) or a place to move to.',
  'cmd37.nl.ask.amount': 'How much? Give the number with its unit (5 m, 30°, 2×).',
  'cmd37.nl.ask.target': 'Which object is the reference? (the first one, #id, the largest building …)',
  'cmd37.nl.ask.kind': 'What should be placed? (house, tree, car …)',
  'cmd37.nl.ask.name': 'What name? Put it in quotes: "North block".',
  'cmd37.nl.ask.field': 'Which field is that value for? Say the field or the unit (energy 1.8e9 J, magnitude 7, x 10).',
  'cmd37.nl.ask.axis': 'Align which edges? (west / east / north / south, fronts, backs, centres)',
  'cmd37.nl.ask.place': 'Where? (here, n4, (40, 60), the junction, the hill …)',
  // Not understood — nothing runs.
  'cmd37.nl.unknown.empty': 'Nothing to run.',
  'cmd37.nl.unknown.words': 'Not understood: {words}. Nothing was changed.',
  'cmd37.nl.unknown.sentence': 'The words are known but the sentence is not a command I can run. Nothing was changed.',
  'cmd37.nl.unknown.negation': 'Sentences with "don\'t", "except", "without" … are never run. Say what should be done.',
  'cmd37.nl.unknown.conditional': 'Conditions and repeats ("if …", "every … seconds", "until …") are not supported.',
  'cmd37.nl.unknown.canonical': 'Not a valid command: {detail}',
  'cmd37.nl.unknown.twoKinds': 'One kind of object per command (trees and cars need two commands).',
  'cmd37.nl.unknown.twoTargets': 'The sentence names more than one set of objects.',
  'cmd37.nl.unknown.facing': 'Facing a compass direction is not supported — give the heading in degrees (heading 90).',
  'cmd37.nl.unknown.specificGap': 'A fixed gap cannot be applied afterwards — give the gap when placing, or distribute evenly.',
  'cmd37.nl.unknown.floors': 'Only buildings have floors.',
  'cmd37.nl.unknown.direction': 'That direction is not supported here — use north / south / east / west.',
  'cmd37.nl.unknown.raiseTo': 'Raising or lowering TO a height is not supported — give the amount (raise by 2 m), or flatten to a height.',
  'cmd37.nl.unknown.unwritable': 'Understood, but it cannot be written as a command: {detail}',
  'cmd37.nl.unknown.provider': 'The language model\'s answer was not a valid command ({detail}). Nothing was changed.',
  // Notes shown with the understood command.
  'cmd37.nl.note.legacy': 'Read by the earlier disaster grammar: placed and started at once, every basic setting written out.',
  'cmd37.nl.note.provider': 'Read by the language model; checked against the command grammar.',
  'cmd37.nl.note.afterUnresolved': 'The {type} it refers to is not in this sentence — it starts {s} s from now.',
};
