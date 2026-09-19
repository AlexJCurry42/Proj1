import { minutesPerDay } from '../constants.js';
import { jday } from '../ext.js';
import { sgp4 } from './sgp4.js';
export function propagate(satrec, ...jdayArgs) {
    // Return a position and velocity vector for a given date and time.
    const j = jday(...jdayArgs);
    const m = (j - satrec.jdsatepoch) * minutesPerDay;
    return sgp4(satrec, m);
}
