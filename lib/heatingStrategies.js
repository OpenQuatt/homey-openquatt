'use strict';

// Homey enum id <-> OpenQuatt select option ("Heating Control Mode").
// Switching only resets the strategies' runtime state; the curve points, the
// Power House settings and the heating permission source stay as they are.
const STRATEGY_TO_OPTION = {
  power_house: 'Power House',
  heating_curve: 'Water Temperature Control (heating curve)',
};

const OPTION_TO_STRATEGY = Object.fromEntries(
  Object.entries(STRATEGY_TO_OPTION).map(([id, option]) => [option, id]),
);

module.exports = { STRATEGY_TO_OPTION, OPTION_TO_STRATEGY };
