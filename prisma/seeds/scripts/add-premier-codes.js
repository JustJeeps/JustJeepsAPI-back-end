/**
 * Script to add Premier Performance codes to vendors_prefix.js
 * This script maps brand names to Premier Performance prefixes
 */

const fs = require('fs');
const path = require('path');

// Premier Performance Brand Mapping (Brand Name -> Premier Code)
const premierMapping = {
  "3D/U": "ACE",
  "UAC": "UAC", 
  "5 Star Tuning": "5ST",
  "74 Weld Inc": "74W",
  "Accell (Holley)": "ACC",
  "Accuair": "ACA",
  "ACL Distribution Inc": "ACL",
  "Adams Driveshaft": "ASD",
  "Addictive Desert Designs": "ADD", // Already exists as "ADD"
  "ADS Racing Shocks (Holley)": "ARS",
  "Advan Wheels": "ADW",
  "Advance Adaptors": "ADV", // Already exists
  "Advanced Accessory Concepts": "AAC",
  "Advanced Clutch Technology": "ACT",
  "AEM Electronics (Holley)": "AEI",
  "AEM Induction (K&N)": "AEM", // Already exists - AEM
  "AEM": "AEM", // Already added
  "Aeromotive Inc.": "AER",
  "AEV": "AEV",
  "AFE": "AFE", // Already exists - aFe Power
  "aFe Power": "AFE", // Already added
  "Agricover Inc.": "ACI",
  "Air Lift": "ALT",
  "Air Lift Performance": "ALK",
  "Air Spencer": "ASP",
  "AirAid Filters (K&N)": "AIR", // Already exists - AIRAID
  "AIRAID": "AIR", // Already exists
  "Alpha Rex USA": "ARX",
  "American Force (Wheel Pros)": "AFW",
  "American Iron Off-Road": "AIO",
  "American Racing (Wheel Pros)": "AMR", // Already exists
  "American Racing": "AMR", // Already exists
  "AMP Research (Real Truck)": "AMP", // Already exists
  "AMP Research": "AMP", // Already added
  "Amp'd (Holley)": "AMD",
  "AMS Performance": "AMS",
  "ANDERSON COMPOSITES": "AND",
  "Anzo USA": "ANZ", // Already exists - ANZO USA
  "ANZO USA": "ANZ", // Already exists
  "AP Racing": "APC",
  "Apex Chassis LLC": "APS",
  "APEX Performance Products": "APX",
  "APEXI": "APE",
  "APR (Holley)": "APR",
  "APR PERFORMANCE": "APP",
  "ARB": "ARB", // Already exists - Already added
  "Arc Lighting": "ARL",
  "Archoil": "ARC",
  "Area Diesel Service": "ADS",
  "Aries (Lippert)": "ARI", // Already exists - Aries Automotive
  "Aries Automotive": "ARI", // Already exists
  "Armorlite": "ARM", // Already exists
  "ARP Fasteners": "ARP",
  "Artec Industries": "ART", // Already exists
  "ATS Diesel Performance": "ATS",
  "ATX Wheels (Wheel Pros)": "ATX",
  "Auto Spring Corp": "ASG",
  "Autometer Products": "AUT",
  "Autotech Sport Tuning": "ATH",
  "AWE Tuning": "AWE", // Already exists - AWE Exhaust
  "AWE Exhaust": "AWE", // Already exists
  "B&M Racing (Holley)": "BNM",
  "B&W Trailer Hitches": "BNW",
  "Baer Brakes (Holley)": "BER", // Already exists - Baer
  "Baer": "BER", // Already exists
  "Baja Built Wheels": "BBW",
  "Baja Designs (Bestop)": "BAJ", // Already exists
  "Baja Designs": "BAJ", // Already exists
  "BAK (Real Truck)": "BAK",
  "Banks Power": "BAN", // Already exists
  "Baxter Performance LLC": "BAX", // Already exists
  "BBK": "BBK", // Already exists
  "BBK Performance": "BBK", // Already exists
  "BC RACING": "BCR",
  "BD Diesel": "BDD",
  "Bedrug (Real Truck)": "BED", // Already exists - BedRug
  "BedRug": "BED", // Already exists
  "Bestop": "BST", // Already exists - Already added
  "BESTOP": "BST", // Already exists - Already added
  "BilletWorkz": "BWZ",
  "Bilstein": "BIL", // Already exists
  "Black Rhino (Wheel Pros)": "BRW", // Already exists - Black Rhino
  "Black Rhino": "BRW", // Already exists
  "Blouch Turbos": "BLC",
  "Body Armor 4x4 (The Wheel Grp)": "DBA", // Already exists - Body Armor 4x4
  "Body Armor 4x4": "DBA", // Already exists
  "Bolt": "BLT", // Already exists - Bolt Lock
  "Bolt Lock": "BLT", // Already exists
  "Boomba Racing Inc": "BBA",
  "Bora Wheel Spacers (Motorsport": "BWS",
  "Borla Performance Industries": "BRL", // Already exists - Borla Performance
  "Borla Performance": "BRL", // Already exists
  "Bostech Fuel": "BTF",
  "Braille Battery Inc": "BRB",
  "BRAUM": "BRM",
  "Brembo": "BRE",
  "Brian Crower": "BRI",
  "BUDDY CLUB": "BUD",
  "Bulldog Winch": "BDW",
  "Bullydog (Derive)": "BUL",
  "Bushwacker (Real Truck)": "BWK", // Already exists - BUSHWACKER
  "BUSHWACKER": "BWK", // Already exists
  "Byrna Technologies Inc.": "BYR",
  "Calvert Racing": "CVR",
  "Camburg": "CBG",
  "Carbing": "CRG",
  "Carbon Reproductions": "CBR",
  "Carbotech Brakes LLC": "CAT",
  "Carli Suspension (Randys)": "CIS",
  "Carrillo": "CRL",
  "Cascadia 4x4 Ltd.": "CSC",
  "Centerforce Clutches": "CFC", // Already exists - Centerforce
  "Centerforce": "CFC", // Already exists
  "CENTRIC PARTS (POSIQUIET)": "POS",
  "Chemical Guys": "CHE", // Already exists
  "Choate Performance Engineering": "CHT",
  "Clayton": "CLY",
  "Cobb Tuning": "COB",
  "Cognito Motorsports (Randys)": "COG",
  "Cold Case Radiators": "CCR",
  "Combat Off Road Inc": "CMB", // Already exists - Combat Off Road
  "Combat Off Road": "CMB", // Already exists
  "Cometic": "COM",
  "Comp Cams (Edelbrock)": "CPC",
  "Company 23": "COP",
  "Competition Clutch": "CCI",
  "Compressive Tuning": "CMP",
  "Cooper Tire & Rubber Company": "CTR", // Already exists - Cooper Tires
  "Cooper Tires": "CTR", // Already exists
  "Corbeau": "CRB", // Already exists
  "Corsa Performance (TMG Perf)": "COR", // Already exists - Corsa Performance
  "Corsa Performance": "COR", // Already exists
  "CR Performance Engineering": "CRP",
  "Crawltek": "CWL",
  "Crown Automotive": "CAS", // Already exists
  "Crown Performance": "CRN", // Already exists - Crown Performance
  "CSF Radiator": "CSF",
  "Currie Enterprises": "CUR", // Already exists
  "Curt (Lippert)": "CRT", // Already exists - Curt Manufacturing
  "CURT": "CRT", // Already exists - Curt Manufacturing
  "Curt Manufacturing": "CRT", // Already exists
  "CUSCO USA": "CUS",
  "Custom Auto Works": "CAW",
  "Custom Performance Engineering": "CPE",
  "D2 Racing (Urban)": "D2R",
  "Dana/Spicer": "DAN", // Already exists - Dana Spicer
  "Dana Spicer": "DAN", // Already exists
  "Darton Sleeves": "DAR",
  "Daystar": "DAY", // Already exists
  "DeatschWerks": "DET",
  "Deaver Springs": "DEV",
  "Decal Mob": "DCL",
  "Decked": "DKD", // Already exists
  "Defi": "DEF",
  "Demon (Holley)": "DMN",
  "Derale Cooling Products": "DER", // Already exists - Derale Performance
  "Derale Performance": "DER", // Already exists
  "Design Engineering": "DEI", // Already exists
  "DFC Diesel": "DFC",
  "Diablosport (Holley)": "DSP",
  "Diamond Eye MFG": "DEM",
  "Dieselsite": "DSS",
  "Different Trends": "DT-",
  "Dinan (Holley)": "DIN",
  "Diode Dynamics LLC": "DOD", // Already exists - Diode Dynamics
  "Diode Dynamics": "DOD", // Already exists
  "DISC BRAKES AUSTRALIA": "DBB",
  "DMM MOTORSPORTS": "DC-",
  "Dometic Corporation": "DOM", // Already exists - Dometic
  "Dometic": "DOM", // Already exists
  "Dragy": "DRG",
  "Dress Up Bolts": "DSB",
  "Driveshaft Shop": "DRS",
  "DuraMax Tuner": "DMT",
  "DV8 Offroad (Drake)": "DV8", // Already exists - DV8 OffRoad
  "DV8 OffRoad": "DV8", // Already exists
  "Dynatrac (Randys)": "DYN", // Already exists
  "Dynomite Diesel Products": "DDP",
  "Earls (Holley)": "ELR",
  "Eaton": "EAT", // Already exists - EATON
  "EATON": "EAT", // Already exists
  "EBC Brakes": "EBC", // Already exists
  "Ecutek": "ECU",
  "Edelbrock": "EDB",
  "Edge Products (Holley)": "EDG",
  "EFILIVE": "EFI",
  "EGR Inc.": "EGR", // Already exists - EGR
  "EGR": "EGR", // Already exists
  "Eibach": "EIB", // Already exists - Eibach Springs
  "Eibach Springs": "EIB", // Already exists
  "Element Fire SDS not listed": "ELE", // Already exists - Element - Fire Extinguishers
  "Element - Fire Extinguishers": "ELE", // Already exists
  "ENERGY SUSPENSION": "ENS", // Already exists - Energy Suspension
  "Energy Suspension": "ENS", // Already exists
  "Enkei": "ENK",
  "EVO Manufacturing Inc.": "EVO", // Already exists - EVO Manufacturing
  "EVO Manufacturing": "EVO", // Already exists
  "EXEDY": "EXE",
  "Exergy": "EXE",
  "Expedition Essentials": "EPD",
  "Extang (Real Truck)": "EXT", // Already exists - Extang
  "Extang": "EXT", // Already exists
  "Extreme Turbo Systems": "ETS",
  "Ezlynk": "EZL",
  "Fab Fours": "FAF", // Already exists
  "Fabtech Motorsports": "FAB", // Already exists - Fabtech
  "Fabtech": "FAB", // Already exists
  "FactionFab": "FFA",
  "Factor 55": "FAC", // Already exists
  "FASS": "FAS",
  "Firepunk": "FNK",
  "Firestone": "FIR", // Already exists
  "Fishbone Offroad": "FBN", // Already exists
  "Fleece Performance": "FLC",
  "Flowmaster (Holley)": "FLM", // Already exists - FlowMaster
  "FlowMaster": "FLM", // Already exists
  "Fluidamper": "FLU",
  "Forced Performance Turbos": "FPT",
  "Ford OEM": "FRD",
  "Ford Performance": "FPP",
  "Fortune Auto": "FOA",
  "Four T Recreation (Freespirit)": "FRT", // Already exists - Free Spirit Recreation
  "Fox Racing Shox": "FOX", // Already exists - Fox Racing
  "Fox Racing": "FOX", // Already exists
  "Front Runner Outfitters": "FRO",
  "FrostBite (Holley)": "FRB",
  "Fuel Injector Clinic": "FIC",
  "Fuel Wheels (Wheel Pros)": "FUE", // Already exists - Fuel Off-Road
  "Fuel Off-Road": "FUE", // Already exists
  "Full Force Diesel": "FFD",
  "Full Throttle Battery": "FTB",
  "Full Windsor": "FWR",
  "Full-Race Motorsports": "FRM",
  "Fumoto": "FMT",
  "Garrett Turbos": "GTT",
  "Gates Corporation": "GAT",
  "Gator Fasteners": "GTF",
  "GCS": "GCS",
  "GDP": "GDP",
  "Gearhead Wax": "GHW",
  "Genesis Offroad": "GNO",
  "Gen-Y": "GEN",
  "Go Fast Bits": "GFB",
  "Go Rhino (Real Truck)": "RHI", // Already exists - Go Rhino
  "Go Rhino": "RHI", // Already exists
  "Gorilla Automotive Products": "GAP", // Already exists - Gorilla Automotive
  "Gorilla Automotive": "GAP", // Already exists
  "Got Your Six Coffee Co.": "GYS",
  "Gram Lights": "GRA",
  "Grams (Group A Eng.)": "GMS",
  "Greddy": "GRD",
  "Grimm OffRoad": "GOR",
  "Grimm Speed": "GRM",
  "GSC Power Division": "GSC",
  "H&R Springs": "HRS",
  "H&S Motorsports LLC": "HSM",
  "H3R Performance - Fire Equipme": "H3R",
  "Hamilton Cams": "HAM",
  "HASPORT PERFORMANCE": "HAS",
  "Hawk Performance": "HWK",
  "Hella Inc.": "HLA", // Already exists - HELLA
  "HELLA": "HLA", // Already exists
  "Hellwig Products": "HEL", // Already exists - Hellwig Suspension
  "Hellwig Suspension": "HEL", // Already exists
  "Helo Wheels (Wheel Pros)": "HLO",
  "Hi-Lift": "HLT", // Already exists - Hi-Lift Jack
  "Hi-Lift Jack": "HLT", // Already exists
  "HKS": "HKS",
  "Holley": "HOL", // Already exists
  "Honda/Acura OEM": "HON",
  "Hondata": "HAD",
  "Hooker (Holley)": "HKR",
  "Hostile Wheels": "HSL",
  "HP Tuners LLC": "HPT",
  "HPS Performance": "HPS",
  "Hurst Performance (Holley)": "HUR",
  "Husky Liners (Real Truck)": "HUS", // Already exists - Husky Liners
  "Husky Liners": "HUS", // Already exists
  "Hutchinson": "HUT",
  "Hypertech": "HYP", // Already exists
  "IAG PERFORMANCE": "IAG",
  "Icon Suspension (Randys)": "IVD",
  "Ignik Outdoors": "IGN",
  "Industrial Injection": "IIS",
  "Injector Dynamics": "IND",
  "Injen Technology": "INJ", // Already exists - INJEN
  "INJEN": "INJ", // Already exists
  "Innovate Motorsports": "INN",
  "INNOVATIVE MANUFACTURING": "ISH",
  "Insta Privy": "INP",
  "INVIDIA": "INV",
  "IRP-Germany": "IRP",
  "ISC Suspension": "ISC",
  "Isspro Inc.": "ISP",
  "J.E.Reel": "JER",
  "J.W. Speaker": "JWS",
  "Jackson Racing (949 Racing)": "JAC",
  "JDM Station": "JDS",
  "Jet Performance": "JET",
  "JKS": "JKS",
  "K&N Engineering": "KAN",
  "Kartboy": "KAR",
  "KC HiLites": "KCL",
  "Kelderman Air Suspension": "KEL",
  "Kelford Technologies": "KEF",
  "KIC": "KIC",
  "Kicker": "KKR",
  "Killer B Motorsports LLC": "KIL",
  "King Bearing": "KGN",
  "King Shock Technology": "KNG",
  "Klean Freak": "KLF",
  "Kleinn Air Horns": "KLN",
  "KMC Wheels (Wheel Pros)": "KMC",
  "KOYORAD Cooling Systems": "KOY",
  "Kryptonite": "KRP",
  "Lawson Hammock": "LAW",
  "LegSport": "LEG",
  "LifeSaver": "JRC",
  "LoD Offroad": "LOD",
  "Lube Locker": "LUB",
  "Lund (Real Truck)": "LND",
  "Luverne (Lippert)": "LUV",
  "MACKIN INDUSTRIES": "MUT",
  "Mads Electronics": "SMA",
  "Mag-Hytech": "MAG",
  "Magnaflow Performance": "MFL",
  "Magnuson Superchargers": "MGS",
  "Mahlle": "MCI",
  "Mahle Aft. Service Solutions": "MSS",
  "Mahle Motorsports": "MLE",
  "Manley Performance": "MAN",
  "Maxton Design": "MAX",
  "Maxxis Tire": "MXT",
  "MBRP Inc.": "MBR",
  "MCE Flexible Fenders (Daystar)": "MCE",
  "McGaughy's Suspension": "MCG",
  "MEGAN RACING": "MGR",
  "Mele Design Firm": "MDF",
  "Merchant Automotive": "MAT",
  "Method Race Wheels": "MRW",
  "Metra": "MET",
  "Mickey Thompson Tires": "MIC",
  "Midland Radio": "MLR",
  "Mishimoto": "MIM",
  "Mob Armor": "MOB",
  "Momo": "MOM",
  "Mooresport Inc.": "MSI",
  "Mopar OE": "MPR",
  "Morimoto": "MRM",
  "Motegi (Wheel Pros)": "MTG",
  "Motiv Concepts": "MTV",
  "Motive Gear": "MOT",
  "Motive Products": "MTP",
  "Moto Metal Wheels (Wheel Pros)": "MTM",
  "Motobilt": "MTB",
  "Motul": "MTL",
  "Mountain Off Road": "MOR",
  "Move Over Racing": "MOV",
  "Mr. Gasket (Holley)": "MRG",
  "MSD (Holley)": "MSD",
  "MXP Exhaust": "MXP",
  "NACHO Offroad Technology": "NAC",
  "Nameless Performance": "NAM",
  "Neapco Components LLC": "NEA",
  "Nemisis Industries": "NEM",
  "N-Fab (Real Truck)": "NFB",
  "NGK Spark Plugs": "NGK",
  "Nitro Gear & Axle": "NGA",
  "No Limit Fabrication": "NLF",
  "Nolathane (Zeder)": "NOL",
  "Nostrum High Performance": "NST",
  "NRG": "NRG",
  "Off Road Engineering LLC": "ORE",
  "Off Road Only": "ORO",
  "Off the Line Performance": "OTL",
  "Ohlins": "OHL",
  "OLM": "OLM",
  "Omnia Sweden": "OMA",
  "Omni-Power USA": "OMN",
  "OpenFlash Performance": "OFP",
  "Oracle Lights": "OCL",
  "Outback Adventure Product": "OUT",
  "Overland Vehicle Systems": "OVS",
  "P3 Gauges": "P3G",
  "Pacbrake": "PAC",
  "Pacific Performance Engineering": "PPE",
  "Pedal Commander": "PEC",
  "Pedders Suspension": "PED",
  "Pelican Products": "PLC",
  "Performance Steering (PSC)": "PSC",
  "Perrin": "PER",
  "Phillips66/Red Line": "RDL",
  "PIAA Corp": "PIA",
  "Planted Technologies": "PLA",
  "Pop & Lock": "POP",
  "Power Stop": "POW",
  "Power-Stroke Products": "PWS",
  "Premier Performance": "PRE",
  "PRL MotorSports": "PRL",
  "ProCharger": "PRG",
  "PROJECT MU": "PMU",
  "Promaxx Performance": "PRX",
  "ProSport": "PRS",
  "PRP Seats (Bestop)": "PRP",
  "PSI Power": "PSI",
  "PST Driveshafts": "PST",
  "PTP Turbo Blankets": "PTP",
  "Pulsar (Holley)": "PUL",
  "Pureflow/AirDog": "PFT",
  "Putco": "PUT",
  "Pypes Performance Exhaust": "PYP",
  "Quake LED": "QKE",
  "Quick Fuel (Holley)": "QKF",
  "Raceline Wheels": "RLW",
  "Radium": "RAD",
  "Rally Armor (RSD)": "RAL",
  "Rally Innovations": "RAI",
  "RallySport Direct": "RSD",
  "RallySport Kits": "RSK",
  "RAM Mounts": "RAM",
  "Rampage (Real Truck)": "RPG",
  "Ranch Hand (Lippert)": "RAN",
  "Rancho": "ROS",
  "Rancho Suspension (DRiV)": "ROS",
  "Randy's Transmission": "RTS",
  "Range Tech (Holley)": "RNG",
  "RAYS WHEELS": "RAY",
  "RCD Performance": "RIV",
  "RCI Metalworks": "RCI",
  "RCV Performance": "RCV",
  "ReadyLift Air": "RLA",
  "Readylift Suspension": "RLS",
  "Recon Lighting": "REC",
  "Redarc": "RED",
  "Reid Racing": "RDR",
  "Remark Inc": "REM",
  "Retrax (Real Truck)": "RTX",
  "Revmax": "RMX",
  "Revolution Gear And Axle": "RGA",
  "Rhino-Rack USA": "RRU",
  "Ridetech": "RDT",
  "Rigid Industries": "RIG",
  "RIPP Supercharger": "RIP",
  "RIVAL 4x4 USA INC": "RVL",
  "Road Armor": "RDA",
  "Roam Adventure Co LLC": "ROM",
  "Rock Hard": "RKH",
  "Rock Jock": "RJK",
  "Rock Krawler": "RKK",
  "Rock Slide Eng": "RSE",
  "Rock Tamers": "RKT",
  "Rotiform 1PC (Wheel Pros)": "RTF",
  "Roto Pax": "RTP",
  "Rough Country": "RCS",
  "Roush Performance": "ROU",
  "Royal Purple": "ROY",
  "RPG Offroad": "GPR",
  "RSI Smartcap": "SMP",
  "Rugged Liners (Real Truck)": "RUG",
  "Rugged Off Road (Ready Lift)": "RGO",
  "Rugged Radios": "RRP",
  "Rugged Ridge (Real Truck)": "RGR",
  "Rust Buster Frameworks": "RBU",
  "S&B Filters": "SAB",
  "S&S Diesel Motorsport": "SAS",
  "Samco": "SAM",
  "Savvy Offroad": "SVO",
  "SCT LLC (Derive)": "SCT",
  "SEIBON CARBON": "SEI",
  "Select Increments": "SLI",
  "Sherpa Equipment": "SEQ",
  "Sinister MFG": "SIN",
  "Skunk2 (Group A Eng.)": "SKN",
  "SMY": "SMY",
  "Sniper (Holley)": "SNI",
  "SoCal Diesel": "SLD",
  "South Bend Clutch": "SBC",
  "SPARCO": "SPR",
  "SPD Performance": "PDP",
  "SPEC-D": "SCD",
  "SPECIALTY PRODUCTS CO.": "SPC",
  "Spidertrax": "SPT",
  "SPL PARTS": "PLP",
  "Spod (Bestop)": "SPD",
  "Spyder": "SPY",
  "Stage 3 Motorsports": "S3M",
  "Stainless Works": "SSW",
  "Stampede (Real Truck)": "STP",
  "Steed Speed": "SED",
  "Steer Smarts": "SSS",
  "Steinjager": "STJ",
  "Sticker Fab": "SFB",
  "Stoptech": "STT",
  "Subaru OEM": "SUB",
  "SUBISPEED": "SBS",
  "Sulastic Shackles": "SHK",
  "Suncoast Converters": "SUN",
  "Superchips (Holley)": "SCI",
  "Superlift (Real Truck)": "SLF",
  "SuperPro (Zeder)": "SPP",
  "Supersprings International Inc": "SSP",
  "Swift": "SWF",
  "Synergy MFG": "SYN",
  "Takata": "TAK",
  "TEIN": "TEI",
  "Tembo Tusk": "TEM",
  "Teraflex Suspension": "TER",
  "The Wheel Group": "TWG",
  "Tial": "TIA",
  "Timbren": "TIM",
  "Tireco (Milestar Tires)": "TCO",
  "TITAN 7": "TTN",
  "Titan Fuel Tanks": "TFT",
  "Tomei": "TOM",
  "TOMS (APEX)": "TMS",
  "Torque Solution": "TQS",
  "Toyota": "TOY",
  "Trail Recon": "TRC",
  "Trails By Grimm Speed": "TBG",
  "Transfer Flow": "TSF",
  "Trasharoo": "TSH",
  "TRD": "TRD",
  "T-Rex Grilles": "TRX",
  "Trimax": "TRI",
  "Truhart (Urban)": "TRU",
  "Truxedo Inc (Real Truck)": "TXO",
  "TSW Wheels (Wheel Pros)": "TSW",
  "Tuff Country (Daystar)": "TUF",
  "Turbosmart": "TSU",
  "TurboXS": "TXS",
  "UnderCover Inc (Real Truck)": "UNC",
  "Up Down Air Systems": "UDA",
  "UPR Products": "UPR",
  "USA Standard (Randys)": "USA",
  "UWS (Lippert)": "UWS",
  "Valair Inc": "VAL",
  "Valenti": "VLN",
  "Varis": "VAS",
  "Vector Offroad": "VEC",
  "Vera Air (Urban)": "VAA",
  "Verus Engineering": "VER",
  "Vibrant Performance": "VIB",
  "Victor Reinz (Dana/Spicer)": "VRZ",
  "Vision Wheel": "VZN",
  "Volant (TMG)": "VOL",
  "Volk Racing": "VLK",
  "Voodoo Off Road (Daystar)": "VOR",
  "Vortech": "VTC",
  "Wagler Competition": "WCP",
  "Wagner Tuning LLC": "WAG",
  "Warn Products": "WRN",
  "WeatherTech": "WEA",
  "WedsSport Wheels": "WED",
  "Wehrli Custom Fab": "WCF",
  "Weiand (Holley)": "WEI",
  "Westin Automotive": "WES",
  "WheelMate": "WMP",
  "Whipple Superchargers": "WHP",
  "WHITELINE (ZEDER)": "WHI",
  "Willwood": "WIL",
  "Wiseco": "WIS",
  "Work Wheels USA": "WOR",
  "X Force": "XFO",
  "XClutch USA": "XCL",
  "XD Wheels (Wheel Pros)": "XDW",
  "XK Glow": "XKG",
  "Yakima": "YAK",
  "Yukon Gear and Axle (Randys)": "YUK",
  "Z-Automotive (Part Alliance)": "ZAT",
  "Zone Offroad (Fox)": "ZON",
  "Zroadz (T-Rex)": "ZRD",
  "Zumbrota (Randys)": "ZUM"
};

// Alternative brand name mappings for better matching
const alternativeBrandNames = {
  "aFe Power": ["AFE"],
  "AIRAID": ["AirAid Filters (K&N)"],
  "ANZO USA": ["Anzo USA"],
  "BESTOP": ["Bestop"],
  "BUSHWACKER": ["Bushwacker (Real Truck)"],
  "BedRug": ["Bedrug (Real Truck)"],
  "Body Armor 4x4": ["Body Armor 4x4 (The Wheel Grp)"],
  "Bolt Lock": ["Bolt"],
  "Borla Performance": ["Borla Performance Industries"],
  "Chemical Guys": ["Chemical Guys"],
  "Combat Off Road": ["Combat Off Road Inc"],
  "Cooper Tires": ["Cooper Tire & Rubber Company"],
  "Corsa Performance": ["Corsa Performance (TMG Perf)"],
  "Crown Performance": ["Crown Performance Products"],
  "Curt Manufacturing": ["Curt (Lippert)", "CURT"],
  "Dana Spicer": ["Dana/Spicer"],
  "Derale Performance": ["Derale Cooling Products"],
  "Design Engineering": ["Design Engineering"],
  "Diode Dynamics": ["Diode Dynamics LLC"],
  "DV8 OffRoad": ["DV8 Offroad (Drake)"],
  "EATON": ["Eaton"],
  "EBC Brakes": ["EBC Brakes"],
  "EGR": ["EGR Inc."],
  "Eibach Springs": ["Eibach"],
  "Element - Fire Extinguishers": ["Element Fire SDS not listed"],
  "Energy Suspension": ["ENERGY SUSPENSION"],
  "EVO Manufacturing": ["EVO Manufacturing Inc."],
  "Extang": ["Extang (Real Truck)"],
  "Fabtech": ["Fabtech Motorsports"],
  "FlowMaster": ["Flowmaster (Holley)"],
  "Fox Racing": ["Fox Racing Shox"],
  "Fuel Off-Road": ["Fuel Wheels (Wheel Pros)"],
  "Go Rhino": ["Go Rhino (Real Truck)"],
  "Gorilla Automotive": ["Gorilla Automotive Products"],
  "HELLA": ["Hella Inc."],
  "Hellwig Suspension": ["Hellwig Products"],
  "Hi-Lift Jack": ["Hi-Lift"],
  "Husky Liners": ["Husky Liners (Real Truck)"],
  "INJEN": ["Injen Technology"]
};

async function addPremierCodesToVendorsPrefix() {
  try {
    const filePath = path.join(__dirname, '../hard-code_data/vendors_prefix.js');
    let content = fs.readFileSync(filePath, 'utf8');
    
    console.log('🔄 Adding Premier Performance codes to vendors_prefix.js');
    console.log(`📊 Total Premier brands to map: ${Object.keys(premierMapping).length}`);
    
    let updatesCount = 0;
    let newEntriesCount = 0;
    let notFoundCount = 0;
    const notFoundBrands = [];
    
    // Track which Premier codes have been mapped
    const mappedCodes = new Set();
    
    // Process each Premier brand mapping
    for (const [brandName, premierCode] of Object.entries(premierMapping)) {
      let found = false;
      
      // Try to find existing entry by brand name
      const brandNameRegex = new RegExp(`brand_name:\\s*"${brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
      
      if (content.match(brandNameRegex)) {
        // Check if premier_code already exists for this entry
        const entryRegex = new RegExp(`({[^}]*brand_name:\\s*"${brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^}]*})`, 'g');
        
        content = content.replace(entryRegex, (match) => {
          if (match.includes('premier_code:')) {
            // Update existing premier_code
            const updated = match.replace(/premier_code:\s*"[^"]*"/, `premier_code: "${premierCode}"`);
            mappedCodes.add(premierCode);
            updatesCount++;
            return updated;
          } else {
            // Add premier_code before the closing brace
            const updated = match.replace(/(\s*}$)/, `,\n    premier_code: "${premierCode}", // ${brandName}\n  }`);
            mappedCodes.add(premierCode);
            updatesCount++;
            return updated;
          }
        });
        found = true;
      }
      
      // Try alternative brand names if not found
      if (!found && alternativeBrandNames[brandName]) {
        for (const altName of alternativeBrandNames[brandName]) {
          const altRegex = new RegExp(`brand_name:\\s*"${altName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g');
          if (content.match(altRegex)) {
            const entryRegex = new RegExp(`({[^}]*brand_name:\\s*"${altName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^}]*})`, 'g');
            
            content = content.replace(entryRegex, (match) => {
              if (match.includes('premier_code:')) {
                const updated = match.replace(/premier_code:\s*"[^"]*"/, `premier_code: "${premierCode}"`);
                mappedCodes.add(premierCode);
                updatesCount++;
                return updated;
              } else {
                const updated = match.replace(/(\s*}$)/, `,\n    premier_code: "${premierCode}", // ${brandName}\n  }`);
                mappedCodes.add(premierCode);
                updatesCount++;
                return updated;
              }
            });
            found = true;
            break;
          }
        }
      }
      
      if (!found) {
        notFoundBrands.push({ brand: brandName, code: premierCode });
        notFoundCount++;
      }
    }
    
    // Write the updated content
    fs.writeFileSync(filePath, content);
    
    console.log('\n✅ Premier Performance codes mapping completed!');
    console.log(`📊 Summary:`);
    console.log(`   Updated existing entries: ${updatesCount}`);
    console.log(`   New entries created: ${newEntriesCount}`);
    console.log(`   Brands not found: ${notFoundCount}`);
    console.log(`   Total Premier codes mapped: ${mappedCodes.size}`);
    
    if (notFoundBrands.length > 0) {
      console.log('\n⚠️  Brands not found in existing vendors_prefix.js:');
      notFoundBrands.forEach(item => {
        console.log(`   ${item.code}: ${item.brand}`);
      });
      
      console.log('\n💡 You may need to create new entries for these brands manually.');
    }
    
    console.log('\n🎉 Premier Performance integration setup complete!');
    
  } catch (error) {
    console.error('❌ Error adding Premier codes:', error);
  }
}

// Run the script
addPremierCodesToVendorsPrefix();