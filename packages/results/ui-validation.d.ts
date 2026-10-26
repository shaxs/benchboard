import type { UIWorksheet, UIBindings, UIBaseline } from './ui-contract.mjs';
export { UIWorksheetError } from './ui-contract.mjs';
/** Validates metadata against explicit facts. Caller is responsible for obtaining verified Report/parent facts. No IO/authentication. */
export declare function validateUIWorksheetFacts(value:unknown,expected:{readonly bindings:UIBindings;readonly baseline:UIBaseline}):UIWorksheet;
export declare function uiScorerInputOf(value:UIWorksheet):{reviewer:string;reviewedAt:string;baselineCompared:true;evidence:string;scores:UIWorksheet['scores'];improvements:Record<string,string>};
