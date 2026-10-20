/**
 * Country / jurisdiction tax pack registry.
 * Statuses are truthful capability claims — not compliance certifications.
 */

export type PackVerificationStatus =
  | "generic_unverified"
  | "draft_config"
  | "verified_config_calc"
  | "verified_reporting"
  | "filing_integration";

export type TaxCountryPack = {
  id: string;
  countryCodes: string[];
  regime: "vat" | "gst" | "sales_tax" | "other" | "none";
  label: string;
  terminology: { taxName: string; registrationLabel: string };
  verificationStatus: PackVerificationStatus;
  version: string;
  sourceRefs: string[];
  sourceEffectiveNote: string;
  supportedFeatures: string[];
  knownLimitations: string[];
  filingStatus: "not_implemented";
};

export const TAX_COUNTRY_PACKS: TaxCountryPack[] = [
  {
    id: "gb_vat_config",
    countryCodes: ["GB"],
    regime: "vat",
    label: "United Kingdom — VAT (configuration)",
    terminology: { taxName: "VAT", registrationLabel: "VAT registration number" },
    verificationStatus: "draft_config",
    version: "2026.10.1",
    sourceRefs: ["https://www.gov.uk/vat-rates"],
    sourceEffectiveNote:
      "Starter rates are illustrative for configuration only — confirm current HMRC rates before use.",
    supportedFeatures: [
      "registration_fields",
      "effective_dated_rates",
      "standard_reduced_zero_exempt_outside_scope_codes",
      "output_input_gl_mapping",
      "internal_tax_summary_report",
    ],
    knownLimitations: [
      "No MTD / Making Tax Digital",
      "No VAT return box mapping or electronic filing",
      "No partial exemption engine",
    ],
    filingStatus: "not_implemented",
  },
  {
    id: "au_gst_config",
    countryCodes: ["AU"],
    regime: "gst",
    label: "Australia — GST (configuration)",
    terminology: { taxName: "GST", registrationLabel: "ABN / GST registration" },
    verificationStatus: "draft_config",
    version: "2026.10.1",
    sourceRefs: ["https://www.ato.gov.au/businesses-and-organisations/gst-excise"],
    sourceEffectiveNote: "Starter 10% GST stub — verify against ATO before use.",
    supportedFeatures: ["registration_fields", "effective_dated_rates", "gl_mapping", "internal_tax_summary"],
    knownLimitations: ["No BAS preparation or lodgement", "No ATO integration"],
    filingStatus: "not_implemented",
  },
  {
    id: "nz_gst_config",
    countryCodes: ["NZ"],
    regime: "gst",
    label: "New Zealand — GST (configuration)",
    terminology: { taxName: "GST", registrationLabel: "IRD GST number" },
    verificationStatus: "draft_config",
    version: "2026.10.1",
    sourceRefs: ["https://www.ird.govt.nz/gst"],
    sourceEffectiveNote: "Starter GST stub — verify against IRD.",
    supportedFeatures: ["registration_fields", "effective_dated_rates", "gl_mapping", "internal_tax_summary"],
    knownLimitations: ["No IRD filing"],
    filingStatus: "not_implemented",
  },
  {
    id: "sg_gst_config",
    countryCodes: ["SG"],
    regime: "gst",
    label: "Singapore — GST (configuration)",
    terminology: { taxName: "GST", registrationLabel: "GST registration number" },
    verificationStatus: "draft_config",
    version: "2026.10.1",
    sourceRefs: ["https://www.iras.gov.sg/taxes/goods-services-tax-gst"],
    sourceEffectiveNote: "Starter rate stub (9%) — verify against IRAS current rate.",
    supportedFeatures: ["registration_fields", "effective_dated_rates", "gl_mapping"],
    knownLimitations: ["No IRAS filing"],
    filingStatus: "not_implemented",
  },
  {
    id: "ca_gst_hst_manual",
    countryCodes: ["CA"],
    regime: "sales_tax",
    label: "Canada — GST/HST/PST (manual)",
    terminology: { taxName: "GST/HST", registrationLabel: "GST/HST account number" },
    verificationStatus: "generic_unverified",
    version: "2026.10.1",
    sourceRefs: ["https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses.html"],
    sourceEffectiveNote:
      "No automatic provincial rates. Configure GST/HST/PST/QST components manually per province.",
    supportedFeatures: ["manual_rates", "gl_mapping", "internal_tax_summary"],
    knownLimitations: [
      "No place-of-supply engine",
      "No automatic combined rates",
      "Not comprehensive Canadian coverage",
    ],
    filingStatus: "not_implemented",
  },
  {
    id: "na_sales_tax_manual",
    countryCodes: ["US"],
    regime: "sales_tax",
    label: "United States — sales/use tax (manual)",
    terminology: { taxName: "Sales tax", registrationLabel: "State tax ID / permit" },
    verificationStatus: "generic_unverified",
    version: "2026.10.1",
    sourceRefs: [],
    sourceEffectiveNote:
      "There is no single US national sales-tax rate. Configure state/local rates manually. Federal income tax is out of scope.",
    supportedFeatures: ["manual_rates", "jurisdiction_code_field", "gl_mapping"],
    knownLimitations: [
      "No nexus determination",
      "No automated jurisdiction rate provider",
      "No automated filing",
    ],
    filingStatus: "not_implemented",
  },
  {
    id: "in_gst_config",
    countryCodes: ["IN"],
    regime: "gst",
    label: "India — GST (configuration scaffold)",
    terminology: { taxName: "GST", registrationLabel: "GSTIN" },
    verificationStatus: "generic_unverified",
    version: "2026.10.1",
    sourceRefs: ["https://www.gst.gov.in/"],
    sourceEffectiveNote:
      "CGST/SGST/IGST component rates are not invented — organisation must configure. Scaffold only.",
    supportedFeatures: ["registration_fields", "component_placeholders"],
    knownLimitations: [
      "No GSTN / e-invoice integration",
      "No automatic intra vs inter-state determination",
      "No GST return generation",
    ],
    filingStatus: "not_implemented",
  },
  {
    id: "za_vat_config",
    countryCodes: ["ZA"],
    regime: "vat",
    label: "South Africa — VAT (configuration)",
    terminology: { taxName: "VAT", registrationLabel: "VAT registration number" },
    verificationStatus: "draft_config",
    version: "2026.10.1",
    sourceRefs: ["https://www.sars.gov.za/types-of-tax/value-added-tax/"],
    sourceEffectiveNote: "Starter rate stub — verify against SARS.",
    supportedFeatures: ["registration_fields", "effective_dated_rates", "gl_mapping"],
    knownLimitations: ["No SARS eFiling"],
    filingStatus: "not_implemented",
  },
  {
    id: "ae_vat_config",
    countryCodes: ["AE"],
    regime: "vat",
    label: "United Arab Emirates — VAT (configuration)",
    terminology: { taxName: "VAT", registrationLabel: "Tax registration number (TRN)" },
    verificationStatus: "draft_config",
    version: "2026.10.1",
    sourceRefs: ["https://tax.gov.ae/"],
    sourceEffectiveNote: "Starter rate stub — verify against FTA.",
    supportedFeatures: ["registration_fields", "effective_dated_rates", "gl_mapping"],
    knownLimitations: ["No FTA filing"],
    filingStatus: "not_implemented",
  },
  {
    id: "generic_vat",
    countryCodes: ["*"],
    regime: "vat",
    label: "Generic VAT (unverified)",
    terminology: { taxName: "VAT", registrationLabel: "Tax registration number" },
    verificationStatus: "generic_unverified",
    version: "2026.10.1",
    sourceRefs: [],
    sourceEffectiveNote: "Not legal guidance. Customise rates for your jurisdiction.",
    supportedFeatures: ["manual_configuration"],
    knownLimitations: ["Not country-verified"],
    filingStatus: "not_implemented",
  },
  {
    id: "generic_gst",
    countryCodes: ["*"],
    regime: "gst",
    label: "Generic GST (unverified)",
    terminology: { taxName: "GST", registrationLabel: "GST registration number" },
    verificationStatus: "generic_unverified",
    version: "2026.10.1",
    sourceRefs: [],
    sourceEffectiveNote: "Not legal guidance.",
    supportedFeatures: ["manual_configuration"],
    knownLimitations: ["Not country-verified"],
    filingStatus: "not_implemented",
  },
];

export function packsForCountry(countryCode: string): TaxCountryPack[] {
  const cc = countryCode.toUpperCase();
  const specific = TAX_COUNTRY_PACKS.filter((p) => p.countryCodes.includes(cc));
  if (specific.length) return specific;
  return TAX_COUNTRY_PACKS.filter((p) => p.countryCodes.includes("*"));
}

export function suggestedRegimeForCountry(countryCode: string): string {
  const packs = packsForCountry(countryCode);
  return packs[0]?.regime ?? "none";
}

export function packById(id: string): TaxCountryPack | undefined {
  return TAX_COUNTRY_PACKS.find((p) => p.id === id);
}

export function verificationStatusLabel(status: PackVerificationStatus): string {
  switch (status) {
    case "generic_unverified":
      return "Generic / unverified";
    case "draft_config":
      return "Draft — configuration only";
    case "verified_config_calc":
      return "Verified for configuration & calculation";
    case "verified_reporting":
      return "Verified for specified reporting";
    case "filing_integration":
      return "Filing integration verified";
    default:
      return status;
  }
}

/** @deprecated Prefer TAX_COUNTRY_PACKS — kept for existing imports */
export const SUPPORTED_TAX_PACKS = TAX_COUNTRY_PACKS.map((p) => ({
  regime: p.regime,
  label: p.label,
  jurisdictions: p.countryCodes,
  notes: `${verificationStatusLabel(p.verificationStatus)}. ${p.knownLimitations.join(" ")}`,
}));
