package com.jharokha.owner

import android.app.Application
import com.jharokha.owner.data.Hub

class JharokhaApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Hub.init(this)
    }
}
