/* EventsManager.js */
class EventsManager {
    #eventListeners = {};

    get listeners(){ 
        return this.#eventListeners; 
    }

    trigger(eventName, ...data){
        const list = this.#eventListeners[eventName];
        if(!list) return false;

        // Esegui e filtra eventuali null
        for(const fn of list){
            fn?.(...data);
        }
        this.#eventListeners[eventName] = list.filter(Boolean);

        return true;
    }

    on(eventName, callback){
        if(!this.#eventListeners[eventName])
            this.#eventListeners[eventName] = [];
        this.#eventListeners[eventName].push(callback);
        return callback;
    }

    off(eventName, callback){
        const list = this.#eventListeners[eventName];
        if(!list) return;

        if(!callback)
            return list.splice(0, list.length);

        const i = list.indexOf(callback);
        if(i >= 0) list.splice(i, 1);
    }

    once(eventName, callback){
        const wrapper = (...data) => {
            this.off(eventName, wrapper);
            callback(...data);
        };
        this.on(eventName, wrapper);
        return wrapper;
    }
}

export default EventsManager;
