/** A reload would lose Field Mode position, the completion form or typed input, so the update offer waits until none is on screen. */
export const canOfferUpdate = (route: string, dirty: boolean) => !dirty && !/^\/(field|done)\//.test(route);
