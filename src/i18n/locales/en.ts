import type { MessageKey } from './ko';

export const en: Record<MessageKey, string> = {
  // App
  'app.title': 'Disaster Simulation Sandbox',
  'app.untitled': 'Untitled Project',
  'app.loadingPhysics': 'Initializing physics engine…',

  // Top bar
  'topbar.projectName': 'Project name',
  'topbar.save': 'Save',
  'topbar.load': 'Load',
  'topbar.more': 'More',
  'topbar.new': 'New project',
  'topbar.sample': 'Load sample town',
  'topbar.export': 'Export to file (.json)',
  'topbar.import': 'Import from file (.json)',
  'topbar.undo': 'Undo (Ctrl+Z)',
  'topbar.redo': 'Redo (Ctrl+Shift+Z)',
  'topbar.help': 'Help & shortcuts',
  'topbar.language': 'Language',
  'topbar.languageToggle': '한국어로 전환',

  // Modes
  'mode.editor': 'Editor Mode',
  'mode.simulation': 'Simulation Mode',
  'mode.editorShort': 'EDITOR',
  'mode.simulationShort': 'SIMULATION',

  // Panels
  'panel.objects': 'Objects',
  'panel.inspector': 'Inspector',
  'panel.command': 'Command',
  'panel.wind': 'Wind Settings',
  'panel.timeline': 'Timeline',

  // Categories
  'category.environment': 'Environment',
  'category.buildings': 'Buildings',
  'category.nature': 'Nature',
  'category.vehicles': 'Vehicles',
  'category.people': 'People',
  'category.infrastructure': 'Infrastructure',

  // Viewport
  'viewport.hint.camera': 'Left-drag: orbit · Right-drag: pan · Wheel: zoom',
  'viewport.compass.n': 'N',
  'viewport.compass.e': 'E',
  'viewport.compass.s': 'S',
  'viewport.compass.w': 'W',

  // Generic
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.confirm': 'OK',
  'common.comingSoon': 'Soon',
  'common.on': 'On',
  'common.off': 'Off',
  'common.none': 'None',
};
