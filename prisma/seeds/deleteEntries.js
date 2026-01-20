const { PrismaClient } = require("@prisma/client");

async function main() {
  const prisma = new PrismaClient();

  try {
    await prisma.product.deleteMany({
      where: {
        jj_prefix: {
          
          in: ["CURT"]
          // in: [
          //   "CRB", "DD", "SWS", "EVO", "ACP", "RH", "ADD", "WTC", "RAM", "AFE", "AEV", "ART", "BOR", 
          //   "BHO", "ALP", "ALY", "ATP", "AMP", "MIS", "ACC", "CRP", "AVS", "ROM", "ARB", "VA", "AOC", 
          //   "ARS", "HOR", "AML", "GTS", "RUR", "JET", "GEN", "BAJ", "PAV", "RBP", "BED", "AJT", "BST", 
          //   "BFG", "OVO", "BIL", "BLR", "AIR", "BC", "BOA", "BOL", "BAP", "RK", "ROR", "BMR", "BUC", 
          //   "BUB", "BUS", "FLK", "RG", "SOR", "CAR", "RKJ", "CVR", "MRW", "BRM", "XKG", "ANU", "CFR", 
          //   "COB", "UTS", "GRF", "COR", "MCE", "CRO", "SSU", "DSP", "SC", "HEI", "DAY", "DIL", "AEM", 
          //   "DMX", "ARI", "KLN", "MMT", "BLX", "DID", "DC", "DV8", "DYN", "PTX", "DKD", "EAT", "EBC", 
          //   "AWE", "CMF", "MMO", "ESP", "WOR", "ADC", "EXP", "EXR", "CAT", "CLF", "DOD", "FBF", "MXS", 
          //   "FBT", "F55", "FCI", "FIS", "FKL", "RAC", "FLM", "FOR", "FOX", "ECL", "FAD", "PPR", "MEY", 
          //   "G2", "MON", "PPP", "GRV", "GRA", "F52", "GOR", "GRP", "SCH", "ACO", "BDS", "INS", "MMI", 
          //   "HEL", "HIL", "MOR", "HOP", "PIA", "PRE", "CGG", "HU", "HVC", "ODY", "ESU", "PLC", "REC", 
          //   "SPA", "ABZ", "JWS", "ADV", "AID", "JBA", "JKS", "ELE", "K&N", "KCH", "KEN", "KCR", "KEY", 
          //   "MOO", "KMC", "RIP", "RNX", "LAO", "ROL", "SUR", "LOD", "LUK", "LUL", "LYN", "CAM", "DRT", 
          //   "DUH", "MGF", "EXT", "MRS", "HT", "MST", "PRS", "MBP", "SWP", "MCG", "TIM", "ACA", "AMR", 
          //   "MO", "MDJ", "DOR", "HTP", "NOC", "MKT", "NOV", "MSC", "MRY", "MOG", "OOG", "ORV", "NFB", 
          //   "NAP", "TR", "NIT", "ATW", "BRI", "CER", "CHG", "OA", "COV", "IPC", "OME", "MAW", "ORL", 
          //   "OVS", "PED", "ROX", "SFX", "ORD", "SLN", "TEK", "PCW", "TFS", "THR", "ANC", "AO", "PS", 
          //   "ARE", "BBK", "DOM", "DZE", "EIB", "POR", "PST", "PSC", "FSR", "PUT", "PXA", "FTN", "QTC", 
          //   "QTP", "QKE", "FUA", "GAT", "GSM", "RPG", "HAH", "RAN", "RL", "HOL", "RES", "HWG", "JAM", 
          //   "RHI", "RIG", "JJ", "RIV", "KRK", "LCP", "RSE", "RNB", "LGA", "MAB", "MCH", "NGK", "ROT", 
          //   "NKT", "RC", "RUB", "RR", "RSI", "RTO", "RBS", "OBA", "OSS", "SB", "SBL", "PGX", "PRP", 
          //   "SCP", "SHM", "SWA", "SKY", "SYL", "SPT", "TGA", "TOM", "SMA", "TRA", "SUP", "UDA", "SUW", 
          //   "VX", "B", "C", "D", "SYN", "E", "TCK", "F", "TER", "G", "TFX", "H", "TH", "I", "J", "TO", 
          //   "K", "L", "M", "TUX", "TY", "N", "O", "P", "Q", "R", "VSH", "VDP", "S", "T", "WAR", "WA", 
          //   "WES", "U", "V", "W", "XGC", "X", "Y", "YUK", "Z", "ZAM", "ZOR", "ZRD"
          // ]
        }
      },
    });
    console.log('Entries with JJPREFIX equal to PRE or BST deleted successfully.');
  } catch (error) {
    console.error('Error deleting entries:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();

//
