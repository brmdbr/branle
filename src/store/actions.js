import {encrypt} from 'nostr-tools/nip04'
import {Notify, LocalStorage} from 'quasar'

import {pool} from '../pool'
import {dbSave, dbGetProfile, dbGetContactList} from '../db'

export function initKeys(store, keys) {
  store.commit('setKeys', keys)

  // also initialize the lastNotificationRead value
  store.commit('haveReadNotifications')
}

export async function launch(store) {
  if (!store.state.keys.pub) {
    store.commit('setKeys') // passing no arguments will cause a new seed to be generated

    // also initialize the lastNotificationRead value
    store.commit('haveReadNotifications')
  }

  // now we already have a key
  if (store.state.keys.priv) {
    pool.setPrivateKey(store.state.keys.priv)
  }

  // translate localStorage into a kind3 event -- or load relays and following from event
  let contactList = await dbGetContactList(store.state.keys.pub)
  var {relays, following} = store.state
  if (contactList) {
    try {
      relays = JSON.parse(contactList.content)
    } catch (err) {
      /***/
    }
    following = contactList.tags
      .filter(([t, v]) => t === 'p' && v)
      .map(([_, v]) => v)
  } else {
    // get stuff from localstorage and save to store -- which will trigger the eventize
    // plugin to create and publish a contactlist event
    relays = LocalStorage.getItem('relays') || relays
    following = LocalStorage.getItem('following') || following
  }

  // update store state
  store.commit('setFollowing', following)
  store.commit('setRelays', relays)

  // setup pool
  for (let url in store.state.relays) {
    pool.addRelay(url, store.state.relays[url])
  }
  pool.onNotice((notice, relay) => {
    Notify.create({
      message: `Relay ${relay.url} says: ${notice}`,
      color: 'pink'
    })
  })

  // preload our own profile from the db
  await store.dispatch('useProfile', {pubkey: store.state.keys.pub})

  // start listening for nostr events
  store.dispatch('restartMainSubscription')
}

var mainSub = pool

export function restartMainSubscription(store) {
  mainSub = mainSub.sub(
    {
      filter: [
        // notes, profiles and contact lists of people we follow (and ourselves)
        {
          kinds: [0, 1, 2, 3],
          authors: store.state.following.concat(store.state.keys.pub)
        },

        // posts mentioning us and direct messages to us
        {
          kinds: [1, 4],
          '#p': [store.state.keys.pub]
        },

        // our own direct messages to other people
        {
          kinds: [4],
          authors: [store.state.keys.pub]
        }
      ],
      cb: async (event, relay) => {
        switch (event.kind) {
          case 0:
            break
          case 1:
            break
          case 2:
            break
          case 3: {
            if (event.pubkey === store.state.keys.pub) {
              // we got a new contact list from ourselves
              // we must update our local relays and following lists
              // if we don't have any local lists yet
              let local = await dbGetContactList(store.state.keys.pub)
              if (!local || local.created_at < event.created_at) {
                var relays, following
                try {
                  relays = JSON.parse(event.content)
                  store.commit('setRelays', relays)
                } catch (err) {
                  /***/
                }

                following = event.tags
                  .filter(([t, v]) => t === 'p' && v)
                  .map(([_, v]) => v)
                store.commit('setFollowing', following)

                following.forEach(f =>
                  store.dispatch('useProfile', {pubkey: f})
                )
              }
            }
            break
          }
          case 4:
            break
        }

        store.dispatch('addEvent', event)
      }
    },
    'main-channel'
  )
}

export async function sendPost(store, {message, tags = [], kind = 1}) {
  if (message.length === 0) return

  let event = await pool.publish({
    pubkey: store.state.keys.pub,
    created_at: Math.floor(Date.now() / 1000),
    kind,
    tags,
    content: message
  })

  store.dispatch('addEvent', event)
}

export async function setMetadata(store, metadata) {
  let event = await pool.publish({
    pubkey: store.state.keys.pub,
    created_at: Math.floor(Date.now() / 1000),
    kind: 0,
    tags: [],
    content: JSON.stringify(metadata)
  })

  store.dispatch('addEvent', event)
}

export async function sendChatMessage(store, {pubkey, text, replyTo}) {
  if (text.length === 0) return

  let [ciphertext, iv] = encrypt(store.state.keys.priv, pubkey, text)

  // make event
  let event = {
    pubkey: store.state.keys.pub,
    created_at: Math.floor(Date.now() / 1000),
    kind: 4,
    tags: [['p', pubkey]],
    content: ciphertext + '?iv=' + iv
  }
  if (replyTo) {
    event.tags.push(['e', replyTo])
  }

  event = await pool.publish(event)

  store.dispatch('addEvent', event)
}

export async function addEvent(store, event) {
  await dbSave(event)

  // do things after the event is saved
  switch (event.kind) {
    case 0:
      // this will reset the profile cache for this URL
      store.dispatch('useProfile', {pubkey: event.pubkey})
      break
    case 1:
      break
    case 2:
      break
    case 3:
      // this will reset the profile cache for this URL
      store.dispatch('useContacts', event.pubkey)
      break
    case 4:
      break
  }
}

export async function useProfile(store, {pubkey, request = false}) {
  if (pubkey in store.state.profilesCache) {
    // we don't fetch again, but we do commit this so the LRU gets updated
    store.commit('addProfileToCache', store.state.profilesCache[pubkey])
  } else {
    // fetch from db and add to cache
    let event = await dbGetProfile(pubkey)
    if (event) {
      store.commit('addProfileToCache', event)
    } else if (request) {
      // try to request from a relay
      let sub = pool.sub({
        filter: [{authors: [pubkey], kinds: [0]}],
        cb: async event => {
          store.commit('addProfileToCache', event)
          clearTimeout(timeout)
          if (sub) sub.unsub()
        }
      })
      let timeout = setTimeout(() => {
        sub.unsub()
        sub = null
      }, 2000)
    }
  }
}

export async function useContacts(store, pubkey) {
  if (pubkey in store.state.contactListCache) {
    // we don't fetch again, but we do commit this so the LRU gets updated
    store.commit('addContactListToCache', store.state.contactListCache[pubkey])
  } else {
    // fetch from db and add to cache
    let event = await dbGetContactList(pubkey)
    if (event) {
      store.commit('addContactListToCache', event)
    }
  }
}

export async function publishContactList(store) {
  // extend the existing tags
  let event = await dbGetContactList(store.state.keys.pub)
  var tags = event?.tags || []

  // remove contacts that we're not following anymore
  tags = tags.filter(
    ([t, v]) => t === 'p' && store.state.following.find(f => f === v)
  )

  // now we merely add to the existing event because it might contain more data in the
  // tags that we don't want to replace
  store.state.following.forEach(pubkey => {
    if (!tags.find(([t, v]) => t === 'p' && v === pubkey)) {
      tags.push(['p', pubkey])
    }
  })

  event = await pool.publish({
    pubkey: store.state.keys.pub,
    created_at: Math.floor(Date.now() / 1000),
    kind: 3,
    tags,
    content: JSON.stringify(store.state.relays)
  })

  await store.dispatch('addEvent', event)

  Notify.create({
    message: 'Updated and published list of followed keys and relays.',
    color: 'blue'
  })
}
