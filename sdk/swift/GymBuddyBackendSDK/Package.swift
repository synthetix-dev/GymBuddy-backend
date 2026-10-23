// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GymBuddyBackendSDK",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "GymBuddyBackendSDK",
            targets: ["GymBuddyBackendSDK"]
        )
    ],
    targets: [
        .target(
            name: "GymBuddyBackendSDK",
            path: "Sources/GymBuddyBackendSDK"
        ),
        .testTarget(
            name: "GymBuddyBackendSDKTests",
            dependencies: ["GymBuddyBackendSDK"],
            path: "Tests/GymBuddyBackendSDKTests"
        )
    ]
)
