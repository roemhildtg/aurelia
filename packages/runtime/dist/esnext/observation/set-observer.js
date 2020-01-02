import { __decorate, __metadata } from "tslib";
import { ILifecycle } from '../lifecycle';
import { createIndexMap } from '../observation';
import { CollectionSizeObserver } from './collection-size-observer';
import { collectionSubscriberCollection } from './subscriber-collection';
const observerLookup = new WeakMap();
const proto = Set.prototype;
const $add = proto.add;
const $clear = proto.clear;
const $delete = proto.delete;
const native = { add: $add, clear: $clear, delete: $delete };
const methods = ['add', 'clear', 'delete'];
// note: we can't really do much with Set due to the internal data structure not being accessible so we're just using the native calls
// fortunately, add/delete/clear are easy to reconstruct for the indexMap
const observe = {
    // https://tc39.github.io/ecma262/#sec-set.prototype.add
    add: function (value) {
        let $this = this;
        if ($this.$raw !== undefined) {
            $this = $this.$raw;
        }
        const o = observerLookup.get($this);
        if (o === undefined) {
            $add.call($this, value);
            return this;
        }
        const oldSize = $this.size;
        $add.call($this, value);
        const newSize = $this.size;
        if (newSize === oldSize) {
            return this;
        }
        o.indexMap[oldSize] = -2;
        o.notify();
        return this;
    },
    // https://tc39.github.io/ecma262/#sec-set.prototype.clear
    clear: function () {
        let $this = this;
        if ($this.$raw !== undefined) {
            $this = $this.$raw;
        }
        const o = observerLookup.get($this);
        if (o === undefined) {
            return $clear.call($this);
        }
        const size = $this.size;
        if (size > 0) {
            const indexMap = o.indexMap;
            let i = 0;
            for (const entry of $this.keys()) {
                if (indexMap[i] > -1) {
                    indexMap.deletedItems.push(indexMap[i]);
                }
                i++;
            }
            $clear.call($this);
            indexMap.length = 0;
            o.notify();
        }
        return undefined;
    },
    // https://tc39.github.io/ecma262/#sec-set.prototype.delete
    delete: function (value) {
        let $this = this;
        if ($this.$raw !== undefined) {
            $this = $this.$raw;
        }
        const o = observerLookup.get($this);
        if (o === undefined) {
            return $delete.call($this, value);
        }
        const size = $this.size;
        if (size === 0) {
            return false;
        }
        let i = 0;
        const indexMap = o.indexMap;
        for (const entry of $this.keys()) {
            if (entry === value) {
                if (indexMap[i] > -1) {
                    indexMap.deletedItems.push(indexMap[i]);
                }
                indexMap.splice(i, 1);
                const deleteResult = $delete.call($this, value);
                if (deleteResult === true) {
                    o.notify();
                }
                return deleteResult;
            }
            i++;
        }
        return false;
    }
};
const descriptorProps = {
    writable: true,
    enumerable: false,
    configurable: true
};
const def = Reflect.defineProperty;
for (const method of methods) {
    def(observe[method], 'observing', { value: true, writable: false, configurable: false, enumerable: false });
}
let enableSetObservationCalled = false;
export function enableSetObservation() {
    for (const method of methods) {
        if (proto[method].observing !== true) {
            def(proto, method, { ...descriptorProps, value: observe[method] });
        }
    }
}
export function disableSetObservation() {
    for (const method of methods) {
        if (proto[method].observing === true) {
            def(proto, method, { ...descriptorProps, value: native[method] });
        }
    }
}
const slice = Array.prototype.slice;
let SetObserver = class SetObserver {
    constructor(flags, lifecycle, observedSet) {
        if (!enableSetObservationCalled) {
            enableSetObservationCalled = true;
            enableSetObservation();
        }
        this.inBatch = false;
        this.collection = observedSet;
        this.persistentFlags = flags & 2080374799 /* persistentBindingFlags */;
        this.indexMap = createIndexMap(observedSet.size);
        this.lifecycle = lifecycle;
        this.lengthObserver = (void 0);
        observerLookup.set(observedSet, this);
    }
    notify() {
        if (this.lifecycle.batch.depth > 0) {
            if (!this.inBatch) {
                this.inBatch = true;
                this.lifecycle.batch.add(this);
            }
        }
        else {
            this.flushBatch(0 /* none */);
        }
    }
    getLengthObserver() {
        if (this.lengthObserver === void 0) {
            this.lengthObserver = new CollectionSizeObserver(this.collection);
        }
        return this.lengthObserver;
    }
    getIndexObserver(index) {
        throw new Error('Set index observation not supported');
    }
    flushBatch(flags) {
        this.inBatch = false;
        const { indexMap, collection } = this;
        const { size } = collection;
        this.indexMap = createIndexMap(size);
        this.callCollectionSubscribers(indexMap, 16 /* updateTargetInstance */ | this.persistentFlags);
        if (this.lengthObserver !== void 0) {
            this.lengthObserver.setValue(size, 16 /* updateTargetInstance */);
        }
    }
};
SetObserver = __decorate([
    collectionSubscriberCollection(),
    __metadata("design:paramtypes", [Number, Object, Object])
], SetObserver);
export { SetObserver };
export function getSetObserver(flags, lifecycle, observedSet) {
    const observer = observerLookup.get(observedSet);
    if (observer === void 0) {
        return new SetObserver(flags, lifecycle, observedSet);
    }
    return observer;
}
//# sourceMappingURL=set-observer.js.map