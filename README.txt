Monitor and control your OpenQuatt heat pump controller from Homey Pro — fully local, real-time, zero cloud.

OpenQuatt is open firmware for the Quatt Heatpump Controller Q-edition. This app connects Homey directly to the controller on your own network. All data arrives in real time over a live connection, so there is no polling and no cloud account needed.

FEATURES

Device
Your Heatpump Controller Q-edition is discovered automatically on your network, with a manual IP option if needed. The device shows live supply, outside and room temperatures, power consumption, the active control mode, and the aux relay (R2) function and status. You can switch manual cooling and control the aux relay directly from Homey.

Flow cards
Triggers: control mode changed (with mode token), heating started/stopped, cooling started/stopped, a fault was detected/resolved (with fault description token), defrosting started/stopped (per heat pump), boiler turned on/off, silent mode turned on/off.
Conditions: is heating, is cooling, a fault is active, is defrosting, the boiler is active, silent mode is active, aux relay function is.
Actions: set manual cooling enable, force control mode (standby, circulate, anti-freeze or automatic), set silent mode override, set boiler assist, set OpenQuatt control on/off, set aux relay function, switch the R2 relay (external control mode).

Dashboard widget
A glanceable status card for your dashboard: a mode badge (standby, heating, cooling, anti-freeze, offline), six live stats (supply, outside and room temperature, power in, thermal power out, and today's COP — or EER while cooling), plus a smart status line that shows active faults in red or otherwise today's delivered energy and consumption.

REQUIREMENTS

- A Quatt heat pump running the OpenQuatt firmware (see the OpenQuatt project on GitHub)
- Homey Pro (Early 2023 or newer)

Don't have the hardware yet? The ready-made Heatpump Controller Q-edition, purpose-built for OpenQuatt, is available at https://electropaultje.nl/product/heatpump-controller-q-edition/

COMMUNITY

Questions, experiences and discussion: join the OpenQuatt topic on the Tweakers forum at https://gathering.tweakers.net/forum/list_messages/2325776

CREDITS

OpenQuatt is built by jj85, leejoow and the OpenQuatt community. This app is a community project and is not affiliated with Quatt B.V. The OpenQuatt name and logo are used with kind permission of the OpenQuatt maintainers.
