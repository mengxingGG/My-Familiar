import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.familiar.platform"
    compileSdk = 36

    defaultConfig {
        minSdk = 28
        // 库的独立设备测试使用与主应用一致的权限/后台行为目标。
        targetSdk = 36
        ndk { abiFilters += "arm64-v8a" }
        externalNativeBuild {
            cmake {
                arguments += "-DNODE_MOBILE_ROOT=" + projectDir.resolve("../../../.artifacts/android-toolchain/node-mobile").canonicalPath
                arguments += "-DANDROID_STL=c++_shared"
            }
        }

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }
    sourceSets["main"].assets.srcDir(projectDir.resolve("../../../.artifacts/android-assets"))
    // 预编译运行库必须显式入包；仅在 CMake 中 IMPORTED 不会自动打包。
    sourceSets["main"].jniLibs.srcDir(projectDir.resolve("../../../.artifacts/android-toolchain/node-mobile/bin"))
    sourceSets["main"].jniLibs.srcDir(projectDir.resolve("../../../.artifacts/android-wake/jniLibs"))
    sourceSets["main"].java.srcDir("vendor/sherpa-onnx/kotlin")
    sourceSets["androidTest"].assets.srcDir(projectDir.resolve("../../../.artifacts/android-wake/test-assets"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.caverock:androidsvg-aar:1.4")

    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.6.0")
    implementation("com.google.android.material:material:1.7.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
    implementation(project(":tauri-android"))
}
