import type { Bank } from '../types';

/**
 * Curated list of popular Vietnamese banks for VietQR integration.
 * This is a subset of banks supported by VietQR. For the full list,
 * see: https://api.vietqr.io/v2/banks
 */
export const BANKS: Bank[] = [
  {
    id: "970436",
    name: "Vietcombank",
    shortName: "VCB",
    appCode: "vcb",
    logo: "https://api.vietqr.io/img/VCB.png"
  },
  {
    id: "970415",
    name: "VietinBank",
    shortName: "VTB",
    appCode: "vietinbank",
    logo: "https://api.vietqr.io/img/VTB.png"
  },
  {
    id: "970407",
    name: "Techcombank",
    shortName: "TCB",
    appCode: "tcb",
    logo: "https://api.vietqr.io/img/TCB.png"
  },
  {
    id: "970418",
    name: "BIDV",
    shortName: "BIDV",
    appCode: "bidv",
    logo: "https://api.vietqr.io/img/BIDV.png"
  },
  {
    id: "970422",
    name: "MB Bank",
    shortName: "MB",
    appCode: "mbbank",
    logo: "https://api.vietqr.io/img/MB.png"
  },
  {
    id: "970416",
    name: "ACB",
    shortName: "ACB",
    appCode: "acb",
    logo: "https://api.vietqr.io/img/ACB.png"
  },
  {
    id: "970423",
    name: "TPBank",
    shortName: "TPB",
    appCode: "tpbank",
    logo: "https://api.vietqr.io/img/TPB.png"
  },
  {
    id: "970432",
    name: "VPBank",
    shortName: "VPB",
    appCode: "vpbank",
    logo: "https://api.vietqr.io/img/VPB.png"
  },
  {
    id: "970405",
    name: "Agribank",
    shortName: "AGB",
    appCode: "agribank",
    logo: "https://api.vietqr.io/img/AGB.png"
  },
  {
    id: "970403",
    name: "Sacombank",
    shortName: "STB",
    appCode: "sacombank",
    logo: "https://api.vietqr.io/img/STB.png"
  },
  {
    id: "970426",
    name: "MSB",
    shortName: "MSB",
    appCode: "msb",
    logo: "https://api.vietqr.io/img/MSB.png"
  }
];
