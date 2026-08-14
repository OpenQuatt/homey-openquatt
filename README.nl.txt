Bekijk en bestuur je OpenQuatt warmtepomp-controller vanaf Homey Pro — volledig lokaal, realtime, zonder cloud.

OpenQuatt is open firmware voor de Quatt Heatpump Controller Q-edition. Deze app verbindt Homey rechtstreeks met de controller in je eigen netwerk. Alle gegevens komen realtime binnen via een live verbinding, dus zonder polling en zonder cloud-account.

FUNCTIES

Apparaat
Je Heatpump Controller Q-edition wordt automatisch gevonden in je netwerk, met een handmatige IP-optie als dat nodig is. Het apparaat toont live de aanvoer-, buiten- en kamertemperatuur, het stroomverbruik, de actieve control mode en de functie en status van het hulprelais (R2). Handmatige koeling en het hulprelais bedien je rechtstreeks vanuit Homey.

Flow-kaarten
Triggers: control mode veranderd (met mode-token), koelen gestart, koelen gestopt.
Condities: is aan het koelen, is aan het verwarmen, hulprelais-functie is.
Acties: handmatige koeling in- of uitschakelen, hulprelais-functie instellen, het R2-relais schakelen (externe besturing).

Dashboard-widget
Een overzichtelijke statuskaart voor je dashboard: een mode-badge (stand-by, verwarmen, koelen, antivries, offline), zes live waarden (aanvoer-, buiten- en kamertemperatuur, opgenomen vermogen, thermisch vermogen en de COP van vandaag — of EER tijdens het koelen), plus een slimme statusregel die actieve storingen in rood toont en anders de geleverde energie en het verbruik van vandaag.

VEREISTEN

- Een Quatt-warmtepomp met de OpenQuatt-firmware (zie het OpenQuatt-project op GitHub)
- Homey Pro (Early 2023 of nieuwer)

Heb je de hardware nog niet? De kant-en-klare Heatpump Controller Q-edition, speciaal gemaakt voor OpenQuatt, is verkrijgbaar via https://electropaultje.nl/product/heatpump-controller-q-edition/

CREDITS

OpenQuatt is gebouwd door jj85, leejoow en de OpenQuatt-community. Deze app is een community-project en is niet gelieerd aan Quatt B.V. De naam en het logo van OpenQuatt worden gebruikt met toestemming van de OpenQuatt-maintainers.
