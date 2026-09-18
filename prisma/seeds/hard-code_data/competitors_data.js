// competitors_data.js
//
// Order matters: ids come from the autoincrement sequence, and production has
// TDOT as 4 and Lowriders as 5 (inserted by hand before this file caught up).
// seed-hard-code matches by name, so re-running it never duplicates a row.

const competitorsData = [
  {
    name: "Northridge 4x4",
    website: "https://www.northridge4x4.ca/",
  },
  {
    name: "GTA Jeeps & Trucks",
    website: "https://www.gtajeeps.ca/",
  },
  {
    name: "Parts Engine",
    website: "https://www.partsengine.ca/",
  },
  {
    name: "TDOT",
    website: "https://www.tdotperformance.ca/",
  },
  {
    name: "Lowriders",
    website: "https://www.lowriders.ca/",
  },
];

module.exports = competitorsData;
