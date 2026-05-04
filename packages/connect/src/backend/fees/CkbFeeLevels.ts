import { MiscFeeLevels } from './MiscFeeLevels';

export class CkbFeeLevels extends MiscFeeLevels {
    load() {
        return Promise.resolve(this.levels);
    }
}
