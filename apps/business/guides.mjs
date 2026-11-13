import { constants, openSync, closeSync, fstatSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export function createGuideLibrary(directory = '/guides') {
    function read(name, maximum) {
        const descriptor = openSync(join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try { const info = fstatSync(descriptor); if (!info.isFile() || info.nlink !== 1 || info.size > maximum) throw new Error('GUIDE_UNAVAILABLE'); return readFileSync(descriptor); }
        finally { closeSync(descriptor); }
    }
    function catalog() {
        if (!existsSync(join(directory, 'catalog.json'))) return [];
        const values = JSON.parse(read('catalog.json', 65536).toString('utf8'));
        if (!Array.isArray(values) || values.length > 100 || values.some(item => !item || !/^[a-z0-9_-]{1,40}$/.test(item.id) || typeof item.title !== 'string' || item.title.length > 100 || !/^[a-z0-9_-]+\.(?:png|jpg)$/.test(item.file))) throw new Error('GUIDE_UNAVAILABLE');
        return values;
    }
    return {
        list: () => catalog().map(item => ({ id: item.id, title: item.title })),
        image(id) {
            const item = catalog().find(item => item.id === id);
            if (!item) throw new Error('GUIDE_UNAVAILABLE');
            const bytes = read(item.file, 2097152);
            const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg' : undefined;
            if (!type) throw new Error('GUIDE_UNAVAILABLE');
            return { bytes, type };
        },
    };
}
