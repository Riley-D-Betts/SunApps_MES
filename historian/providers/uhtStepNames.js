// Step names from the ThermaStat 5k Aseptic Functional Description.
// Indexed by step number. PROCESS_STEP_NAMES covers the main sequence
// (SIP → Production → AIC → Shutdown, steps 0–37); CIP_STEP_NAMES covers
// the separate CIP sequence (steps 0–33).

const PROCESS_STEP_NAMES = [
  'Idle',                                          // 0
  'Fill Product Balance Tank',                     // 1
  'Homogenizer Safety Check',                      // 2
  'Flood Regen',                                   // 3
  'Bypass Regen',                                  // 4
  'Establish Flash Chamber Level',                 // 5
  'Establish Flow to Homogenizer',                 // 6
  'Establish System Flow',                         // 7
  'Hot Water Heating Active',                      // 8
  'Ramp Up Steam Injector',                        // 9
  'Heat to Legal FDD Temperature',                 // 10
  'Heat to End of Line',                           // 11
  'Sterile Timer Countdown',                       // 12
  'Cooling 1 – Ramp Condenser Water',              // 13
  'Cooling 2 – Ramp Vacuum Pump',                  // 14
  'Cooling 3 – Enable Regen Flow',                 // 15
  'Cooling 4 – Enable Air Break Control',          // 16
  'Enable Final Cooling',                          // 17
  'Stabilize System',                              // 18
  'Sterile on Water',                              // 19
  'W/P1 – Waiting for Product Balance Tank Level', // 20
  'W/P2 – Fill Product Balance Tank',              // 21
  'W/P3 – Lower Flash Vessel Level',               // 22
  'W/P4 – Waiting for Phase Change',               // 23
  'Sterile on Product',                            // 24
  'P/W1 – Waiting for Balance Tank Low Level',     // 25
  'P/W2 – Lower Flash Vessel Level',               // 26
  'P/W3 – Waiting for Phase Change',               // 27
  'In Run Rinse Out',                              // 28
  'AIC – In Run Rinse Out',                        // 29
  'AIC – In Run Add Caustic',                      // 30
  'AIC – Achieve Caustic Circulation Parameters',  // 31
  'AIC – Caustic Circulation',                     // 32
  'AIC – In Run Caustic Rinse Out',                // 33
  'System Cool Down Front End',                    // 34
  'System Cool Down Back End',                     // 35
  'Drain the Flash Chamber',                       // 36
  'Drain Balance Tank / Shut Down Condenser Water',// 37
]

const CIP_STEP_NAMES = [
  'Idle',                                          // 0
  'Fill Balance Tanks',                            // 1
  'Initial Rinse',                                 // 2
  'Rinse with Pulsing',                            // 3
  'Drain Tanks',                                   // 4
  'Fill Water Balance Tank',                       // 5
  'Add Excel HS',                                  // 6
  'Recirc Excel HS @ 155°F',                       // 7
  'Add Caustic',                                   // 8
  'Recirc Caustic in Water Balance Tank @ 185°F',  // 9
  'Recirc Caustic in Product Balance Tank',        // 10
  'Recirc Caustic in Product Balance Tank @ 185°F',// 11
  'Drain Tanks',                                   // 12
  'Fill Balance Tanks',                            // 13
  'Post Caustic Rinse',                            // 14
  'Rinse with Pulsing',                            // 15
  'Drain Tanks',                                   // 16
  'Fill Product Balance Tank',                     // 17
  'Rinse with Pulsing',                            // 18
  'Drain Tanks',                                   // 19
  'Fill Water Balance Tank',                       // 20
  'Add Acid',                                      // 21
  'Recirc Acid in Water Balance Tank @ 150°F',     // 22
  'Recirc Acid in Product Balance Tank',           // 23
  'Recirc Acid in Product Balance Tank @ 150°F',   // 24
  'Drain Tanks',                                   // 25
  'Fill Balance Tanks',                            // 26
  'Post Acid Rinse',                               // 27
  'Post Acid Rinse with Pulsing',                  // 28
  'Drain Tanks',                                   // 29
  'Fill Balance Tanks',                            // 30
  'Rinse with Pulsing',                            // 31
  'Drain Tanks',                                   // 32
  'CIP Complete',                                  // 33
]

module.exports = { PROCESS_STEP_NAMES, CIP_STEP_NAMES }
