<template>
  <q-card class="px-4 py-2">
    <q-card-section>
      <div class="text-lg text-bold tracking-wide leading-relaxed py-2">
        Raw Event Data
      </div>
      <pre class="font-mono">{{ json(cleaned) }}</pre>
    </q-card-section>
  </q-card>
</template>

<script>
import helpersMixin from '../utils/mixin'

export default {
  name: 'RawEventData',
  mixins: [helpersMixin],
  props: {event: {type: Object, required: true}},

  computed: {
    cleaned() {
      if (Array.isArray(this.event))
        return this.event.map(this.withoutLocalMetadata)
      return this.withoutLocalMetadata(this.event)
    }
  },

  methods: {
    withoutLocalMetadata(event) {
      let {_id, _rev, ...evt} = event
      return evt
    }
  }
}
</script>
