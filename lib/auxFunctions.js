'use strict';

// Homey enum id <-> OpenQuatt select option ("Aux Relay Function").
const ID_TO_OPTION = {
  disabled: 'Disabled',
  heating: 'Heating demand',
  cooling: 'Cooling demand',
  heating_or_cooling: 'Heating or cooling demand',
  external: 'External control',
};

const OPTION_TO_ID = Object.fromEntries(
  Object.entries(ID_TO_OPTION).map(([id, option]) => [option, id]),
);

module.exports = { ID_TO_OPTION, OPTION_TO_ID };
